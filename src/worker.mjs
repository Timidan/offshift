// The shift worker: for every running shift, read the owner's BTC position on chain, work out
// what it should be (the followed trader's side, or the preset strategy), and close the gap with
// one IOC order placed by the owner's linked bot key. Every decision starts from chain state, so
// a restart cannot duplicate an order; a transaction still pending from before a restart is
// waited out. Passes run one at a time: a trigger during a pass queues exactly one more pass.
// Triggers: a minute timer, and the followed trader's PositionUpdated event pushed by Somnia
// Reactivity (somnia_watch). The event only wakes the worker; the chain read decides.
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, SOMNIA_MAINNET_PRICE_FEED, PLACE_ORDER_FOR_SELECTOR, contractErrorsAbi } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, encodeEventTopics, getAddress, parseUnits, formatUnits, zeroAddress, ContractFunctionRevertedError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as store from './store.mjs';
import { decide, follow } from './strategy.mjs';

const TICK_MS = 60_000;
const SLIPPAGE_BPS = 50n; // IOC limit 0.5% through the mark
const IOC = 2;
const WS_URL = 'wss://api.hideki2.infra.testnet.somnia.network/ws';
const positionUpdated = parseAbiItem('event PositionUpdated(address indexed account, address indexed perpPool, int128 newSize, uint128 avgEntryPrice, int256 realizedPnl, int256 entryFundingIndex)');
const poolAbi = [
  ...parseAbi(['function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)']),
  ...contractErrorsAbi,
];

const transport = http(hidekiTestnet.rpcUrls.default.http[0], { timeout: 20_000 });
export const rpc = createPublicClient({ chain: hidekiTestnet, transport });
// Hideki's perp oracles read the same price scheduler as mainnet, so its candles warm the strategy.
export const exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql', addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, priceFeed: SOMNIA_MAINNET_PRICE_FEED });
const log = (s, msg) => console.log(`${new Date().toISOString()} shift ${s.id}: ${msg}`);
const abs = (x) => (x < 0n ? -x : x);
const heard = new Map(); // trader → when Reactivity last reported a change
export const moved = new Map(); // any BTC trader → when Reactivity last reported them, for the trader pages

function unitSize(notional, mark, m) {
  const raw = (parseUnits(notional, 18) * 10n ** BigInt(m.baseDecimals)) / mark;
  const lots = (raw / BigInt(m.lotSize)) * BigInt(m.lotSize);
  return lots > BigInt(m.minQuantity) ? lots : BigInt(m.minQuantity);
}

export const openPnl = (size, entry, mark, m) => ((mark - entry) * size) / 10n ** BigInt(m.baseDecimals);

// The shift's PnL so far in USDso: realized since it started, plus the open position's.
// ponytail: counts any manual trades the owner makes on this market during the shift too.
export async function shiftPnl(s, m, size, entry, mark, to) {
  const rows = await exchange.client.listPerpPositionChanges({ account: s.owner, pool: m.poolAddress, from: Math.floor(s.created_at / 1000), to, limit: 1000 });
  const realized = rows.reduce((sum, r) => sum + BigInt(r.realizedPnl), 0n);
  return Number(formatUnits(realized + openPnl(size, entry, mark, m), 18));
}

async function tick(s, m) {
  const bot = privateKeyToAccount(store.botKey(s.bot));
  const [latest, pending] = await Promise.all(['latest', 'pending'].map((blockTag) => rpc.getTransactionCount({ address: bot.address, blockTag })));
  if (pending > latest) return log(s, 'waiting for a pending transaction');

  if (!(await exchange.client.isOperatorAuthorized({ pool: m.poolAddress, owner: s.owner, operator: bot.address, selector: PLACE_ORDER_FOR_SELECTOR }))) {
    store.addEvent(s.id, { kind: 'stopped', note: 'bot access removed' });
    return store.finish(s.id, 'stopped', 'Bot access was removed in dreamDEX.');
  }

  const position = (account) => exchange.client.getPerpPosition({ marginBank: m.marginBank, account, pool: m.poolAddress });
  const [{ size, avgEntryPrice }, { markPrice }, leader, candles] = await Promise.all([
    position(s.owner),
    exchange.client.getPerpState(m.poolAddress),
    s.trader ? position(s.trader) : null,
    s.trader ? null : exchange.client.fetchPriceCandles(s.market, 'M1', { limit: 60 }),
  ]);
  let ending = Date.now() >= s.ends_at;
  const min = BigInt(m.minQuantity), lot = BigInt(m.lotSize);

  if (!ending && s.max_loss && (await shiftPnl(s, m, size, avgEntryPrice, markPrice)) <= -Number(s.max_loss)) {
    store.stopNow(s.id, `The shift's loss limit of ${s.max_loss} USDso was reached.`);
    store.addEvent(s.id, { kind: 'loss-limit', note: `loss reached ${s.max_loss} USDso; closing out` });
    ending = true;
  }
  if (ending && abs(size) < min) {
    // ponytail: a remainder under the market's minimum order cannot be closed by any order; reported, not retried
    store.addEvent(s.id, { kind: 'done', position: String(size) });
    return store.finish(s.id, 'done', size === 0n ? null : `Left ${formatUnits(size, m.baseDecimals)} BTC, below the minimum order.`);
  }

  const qty = unitSize(s.notional, markPrice, m), mark = Number(formatUnits(markPrice, 18));
  let target;
  if (s.trader) {
    const leaderEntry = Number(formatUnits(leader.avgEntryPrice, 18));
    const f = follow({ size, qty, leader: leader.size, leaderEntry, mark, ending });
    target = f.target;
    // One row per skipped entry: a trader adjusting the same side every few seconds adds no rows.
    const skipped = f.skip ? (leader.size > 0n ? 'long' : 'short') : null;
    if (skipped !== s.skipped) {
      store.setSkipped(s.id, skipped);
      const pct = (Math.abs(mark / leaderEntry - 1) * 100).toFixed(2);
      if (skipped) store.addEvent(s.id, { kind: 'skipped', side: skipped, note: `price was ${pct}% past the trader's entry` });
    }
  } else {
    const d = decide({ size, qty, closes: candles.map((c) => c.close), entry: Number(formatUnits(avgEntryPrice, 18)), mark, ending, blocked: s.blocked });
    target = d.target;
    if (d.blocked !== s.blocked) {
      store.setBlocked(s.id, d.blocked);
      if (d.blocked) store.addEvent(s.id, { kind: 'stop-loss', side: d.blocked, note: 'loss reached 1.5%; this side waits for the trend to flip' });
    }
  }
  const delta = target - size;
  const quantity = (abs(delta) / lot) * lot;
  if (quantity < min) return;

  const isBid = delta > 0n;
  const step = BigInt(m.tickSize);
  const price = ((markPrice * (isBid ? 10_000n + SLIPPAGE_BPS : 10_000n - SLIPPAGE_BPS)) / 10_000n / step) * step;
  const expire = BigInt(Date.now() + 60_000) * 1_000_000n;
  const call = { address: m.poolAddress, abi: poolAbi, functionName: 'placeOrderFor', account: bot, args: [s.owner, isBid, 0n, price, quantity, expire, IOC, 0, zeroAddress, 0n] };
  const side = isBid ? 'buy' : 'sell';
  const at = heard.get(s.trader);
  const woke = () => (at && Date.now() - at < 20_000 ? `${((Date.now() - at) / 1000).toFixed(1)} s after Somnia Reactivity reported the trader's change` : null);

  let gas;
  try {
    gas = ((await rpc.estimateContractGas(call)) * 3n) / 2n;
  } catch (e) {
    const revert = e.walk?.((x) => x instanceof ContractFunctionRevertedError);
    if (!revert) throw e; // RPC trouble: try again next tick
    const name = revert.data?.errorName ?? 'unknown revert';
    if (name === 'ImmediateOrCancelNoFill') {
      setTimeout(pass, 10_000); // nothing within 0.5% of the mark: try again soon, not in a minute
      const last = store.events(s.id).at(-1);
      if (last?.kind === 'no-fill' && last.side === side) return; // one row per dry spell
      const w = woke();
      return store.addEvent(s.id, { kind: 'no-fill', side, quantity: String(quantity), price: String(price), note: `no ${isBid ? 'ask' : 'bid'} within 0.5% of the mark${w ? `; tried ${w}` : ''}; retrying` });
    }
    store.addEvent(s.id, { kind: 'failed', side, quantity: String(quantity), note: name });
    return store.finish(s.id, 'failed', `The order was refused: ${name}.`);
  }
  const hash = await createWalletClient({ chain: hidekiTestnet, transport, account: bot }).writeContract({ ...call, gas });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  const after = await position(s.owner);
  const w = woke();
  store.addEvent(s.id, { kind: receipt.status === 'success' ? 'order' : 'reverted', tx: hash, side, quantity: String(quantity), price: String(price), position: String(after.size), note: w && `copied ${w}` });
  log(s, `${side} ${formatUnits(quantity, m.baseDecimals)} BTC → position ${formatUnits(after.size, m.baseDecimals)} (${hash})`);
}

const markets = Object.fromEntries((await exchange.client.listPerpMarkets()).map((m) => [m.baseSymbol, m]));
export { markets, pass };

let busy = false, again = false;
async function pass() {
  if (busy) return void (again = true);
  busy = true;
  try {
    do {
      again = false;
      for (const s of store.runningSessions()) {
        try {
          await tick(s, markets[s.market]);
        } catch (e) {
          log(s, `tick failed, retrying: ${e.shortMessage ?? e.message}`);
        }
      }
    } while (again);
  } finally {
    busy = false;
  }
}

// Somnia Reactivity: the MarginBank's PositionUpdated events for the BTC pool, pushed over WebSocket.
// Events are not buffered across a disconnect, so reconnect and let the timer cover the gap.
function watch(m) {
  const ws = new WebSocket(WS_URL);
  const topics = encodeEventTopics({ abi: [positionUpdated], eventName: 'PositionUpdated', args: { perpPool: m.poolAddress } });
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['somnia_watch', { address: m.marginBank, topics, eth_calls: [] }] }));
  ws.onmessage = ({ data }) => {
    const r = JSON.parse(data).params?.result;
    if (!r?.topics?.[1]) return;
    const account = getAddress(`0x${r.topics[1].slice(26)}`);
    moved.set(account.toLowerCase(), Date.now());
    if (!store.runningSessions().some((s) => s.trader === account)) return;
    heard.set(account, Date.now());
    pass();
  };
  ws.onclose = () => setTimeout(() => watch(m), 5_000);
  ws.onerror = () => {}; // onclose follows and reconnects
}

console.log(`offshift worker on chain ${await rpc.getChainId()}, ${store.runningSessions().length} running shift(s)`);
watch(markets.BTC);
setInterval(pass, TICK_MS);
pass();
