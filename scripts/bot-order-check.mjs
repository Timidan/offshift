// Kill check: the linked bot key places one post-only BTC bid for the owner via
// placeOrderFor, then cancels it via cancelOrderFor. Sends two testnet transactions.
// Usage: OWNER=0x... node scripts/bot-order-check.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, orderBookEventsAbi } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, getAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const owner = getAddress(process.env.OWNER ?? '');
const bot = privateKeyToAccount(readFileSync('.env', 'utf8').match(/^BOT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)[1]);
const transport = http(hidekiTestnet.rpcUrls.default.http[0]);
const rpc = createPublicClient({ chain: hidekiTestnet, transport });
const wallet = createWalletClient({ chain: hidekiTestnet, transport, account: bot });
const exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql', addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });

const poolAbi = parseAbi([
  'function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)',
  'function cancelOrderFor(address owner, uint128 orderId)',
  'function getOwnOpenOrders() view returns (uint128[])',
]);
const POST_ONLY = 3;

async function send(functionName, args) {
  const call = { address: pool, abi: poolAbi, functionName, args, account: bot };
  const gas = ((await rpc.estimateContractGas(call)) * 3n) / 2n; // a new account's first order needs ~3M+
  const hash = await wallet.writeContract({ ...call, gas });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted: ${hash}`);
  return { hash, receipt, events: parseEventLogs({ abi: orderBookEventsAbi, logs: receipt.logs }) };
}
const openOrders = () => rpc.readContract({ address: pool, abi: poolAbi, functionName: 'getOwnOpenOrders', account: owner });

let pool;
try {
  assert.equal(await rpc.getChainId(), 50383, 'Tokyo testnet only');
  const btc = (await exchange.client.listPerpMarkets()).find((m) => m.baseSymbol === 'BTC');
  pool = getAddress(btc.poolAddress);
  const { markPrice } = await exchange.client.getPerpState(pool);
  const tick = BigInt(btc.tickSize), quantity = BigInt(btc.minQuantity);
  const price = ((markPrice * 97n) / 100n / tick) * tick; // 3% under mark: rests, never fills
  const expireNs = BigInt(Date.now() + 10 * 60_000) * 1_000_000n;

  const placed = await send('placeOrderFor', [owner, true, 0n, price, quantity, expireNs, POST_ONLY, 0, zeroAddress, 0n]);
  const ev = placed.events.find((e) => e.eventName === 'OrderPlaced');
  assert(ev, 'no OrderPlaced event');
  const { orderId } = ev.args;
  assert.equal(getAddress(ev.args.placedOrder.owner), owner, 'order owner is not the owner');
  assert((await openOrders()).includes(orderId), 'order not resting for owner');

  const cancelled = await send('cancelOrderFor', [owner, orderId]);
  assert(cancelled.events.some((e) => e.eventName === 'OrderCancelled'), 'no OrderCancelled event');
  assert(!(await openOrders()).includes(orderId), 'order still open');
  const margin = await exchange.client.getMarginAccount(btc.marginBank, owner);

  const report = { at: new Date().toISOString(), owner, bot: bot.address, pool, price, quantity, orderId, placeTx: placed.hash, cancelTx: cancelled.hash, lockedAfter: margin.lockedCollateral, result: 'passed' };
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/bot-order-check.json', JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  console.log(JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
} finally {
  await exchange.close();
}
