// The session worker: once a minute, for every running session, read the owner's BTC position
// on chain, ask the strategy what it should be, and close the gap with one IOC order placed by
// the owner's linked bot key. Every decision starts from chain state, so a restart cannot
// duplicate an order; a transaction still pending from before a restart is waited out.
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, SOMNIA_MAINNET_PRICE_FEED, PLACE_ORDER_FOR_SELECTOR, contractErrorsAbi } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, zeroAddress, ContractFunctionRevertedError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as store from './store.mjs';
import { decide } from './strategy.mjs';

const TICK_MS = 60_000;
const SLIPPAGE_BPS = 50n; // IOC limit 0.5% through the mark
const IOC = 2;
const poolAbi = [
  ...parseAbi(['function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)']),
  ...contractErrorsAbi,
];

const transport = http(hidekiTestnet.rpcUrls.default.http[0], { timeout: 20_000 });
const rpc = createPublicClient({ chain: hidekiTestnet, transport });
// Hideki's perp oracles read the same price scheduler as mainnet, so its candles warm the strategy.
const exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql', addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, priceFeed: SOMNIA_MAINNET_PRICE_FEED });
const log = (s, msg) => console.log(`${new Date().toISOString()} session ${s.id}: ${msg}`);

function unitSize(notional, mark, m) {
  const raw = (parseUnits(notional, 18) * 10n ** BigInt(m.baseDecimals)) / mark;
  const lots = (raw / BigInt(m.lotSize)) * BigInt(m.lotSize);
  return lots > BigInt(m.minQuantity) ? lots : BigInt(m.minQuantity);
}

async function tick(s, m) {
  const bot = privateKeyToAccount(store.botKey(s.owner));
  const [latest, pending] = await Promise.all(['latest', 'pending'].map((blockTag) => rpc.getTransactionCount({ address: bot.address, blockTag })));
  if (pending > latest) return log(s, 'waiting for a pending transaction');

  if (!(await exchange.client.isOperatorAuthorized({ pool: m.poolAddress, owner: s.owner, operator: bot.address, selector: PLACE_ORDER_FOR_SELECTOR }))) {
    store.addEvent(s.id, { kind: 'stopped', note: 'bot access removed' });
    return store.finish(s.id, 'stopped', 'Bot access was removed in dreamDEX.');
  }

  const [{ size, avgEntryPrice }, { markPrice }, candles] = await Promise.all([
    exchange.client.getPerpPosition({ marginBank: m.marginBank, account: s.owner, pool: m.poolAddress }),
    exchange.client.getPerpState(m.poolAddress),
    exchange.client.fetchPriceCandles(s.market, 'M1', { limit: 60 }),
  ]);
  const ending = Date.now() >= s.ends_at;
  const min = BigInt(m.minQuantity), lot = BigInt(m.lotSize);
  if (ending && (size === 0n || (size < 0n ? -size : size) < min)) {
    // ponytail: a remainder under the market's minimum order cannot be closed by any order; reported, not retried
    store.addEvent(s.id, { kind: 'done', position: String(size) });
    return store.finish(s.id, 'done', size === 0n ? null : `Left ${formatUnits(size, m.baseDecimals)} BTC, below the minimum order.`);
  }

  const { target, blocked } = decide({
    size, qty: unitSize(s.notional, markPrice, m), closes: candles.map((c) => c.close),
    entry: Number(formatUnits(avgEntryPrice, 18)), mark: Number(formatUnits(markPrice, 18)), ending, blocked: s.blocked,
  });
  if (blocked !== s.blocked) {
    store.setBlocked(s.id, blocked);
    if (blocked) store.addEvent(s.id, { kind: 'stop-loss', side: blocked, note: 'loss reached 1.5%; this side waits for the trend to flip' });
  }
  const delta = target - size;
  const quantity = ((delta < 0n ? -delta : delta) / lot) * lot;
  if (quantity < min) return;

  const isBid = delta > 0n;
  const step = BigInt(m.tickSize);
  const price = ((markPrice * (isBid ? 10_000n + SLIPPAGE_BPS : 10_000n - SLIPPAGE_BPS)) / 10_000n / step) * step;
  const expire = BigInt(Date.now() + 60_000) * 1_000_000n;
  const call = { address: m.poolAddress, abi: poolAbi, functionName: 'placeOrderFor', account: bot, args: [s.owner, isBid, 0n, price, quantity, expire, IOC, 0, zeroAddress, 0n] };
  const side = isBid ? 'buy' : 'sell';

  let gas;
  try {
    gas = ((await rpc.estimateContractGas(call)) * 3n) / 2n;
  } catch (e) {
    const revert = e.walk?.((x) => x instanceof ContractFunctionRevertedError);
    if (!revert) throw e; // RPC trouble: try again next tick
    const name = revert.data?.errorName ?? 'unknown revert';
    if (name === 'ImmediateOrCancelNoFill') return store.addEvent(s.id, { kind: 'no-fill', side, quantity: String(quantity), price: String(price) });
    store.addEvent(s.id, { kind: 'failed', side, quantity: String(quantity), note: name });
    return store.finish(s.id, 'failed', `The order was refused: ${name}.`);
  }
  const hash = await createWalletClient({ chain: hidekiTestnet, transport, account: bot }).writeContract({ ...call, gas });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  const after = await exchange.client.getPerpPosition({ marginBank: m.marginBank, account: s.owner, pool: m.poolAddress });
  store.addEvent(s.id, { kind: receipt.status === 'success' ? 'order' : 'reverted', tx: hash, side, quantity: String(quantity), price: String(price), position: String(after.size) });
  log(s, `${side} ${formatUnits(quantity, m.baseDecimals)} BTC → position ${formatUnits(after.size, m.baseDecimals)} (${hash})`);
}

const markets = Object.fromEntries((await exchange.client.listPerpMarkets()).map((m) => [m.baseSymbol, m]));
console.log(`offshift worker on chain ${await rpc.getChainId()}, ${store.runningSessions().length} running session(s)`);
for (;;) {
  for (const s of store.runningSessions()) {
    try {
      await tick(s, markets[s.market]);
    } catch (e) {
      log(s, `tick failed, retrying next minute: ${e.shortMessage ?? e.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
