import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activity, byPair, closedOrders } from './insight.mjs';

const p = (n) => BigInt(n) * 10n ** 18n;
const change = (id, pool, kind, timestamp, sizeBefore, sizeAfter, entryPriceBefore, entryPriceAfter, exitPrice, closedSize, realizedPnl, orderId = id) => ({ id, pool, kind, timestamp, sizeBefore, sizeAfter, entryPriceBefore, entryPriceAfter, exitPrice, closedSize, realizedPnl, orderId });
const rows = [
  change(1n, 'btc', 'OPEN', 1000n, 0n, 2n, null, p(100), null, 0n, 0n),
  change(2n, 'btc', 'REDUCE', 1300n, 2n, 1n, p(100), p(100), p(110), 1n, p(10), 9n),
  change(3n, 'btc', 'CLOSE', 1300n, 1n, 0n, p(100), 0n, p(120), 1n, p(20), 9n), // the same order at a second price
  change(4n, 'eth', 'OPEN', 90000n, 0n, -1n, null, p(50), null, 0n, 0n),
  change(5n, 'eth', 'FLIP', 90600n, -1n, 1n, p(50), p(60), p(60), 1n, -p(10)),
];

test('groups fills into orders, and sums each pair and how they trade', () => {
  const orders = closedOrders(rows);
  assert.equal(orders.length, 2);
  assert.equal(orders[0].pnl, p(30));
  assert.equal(orders[0].exit, p(115)); // the average exit, not the last fill

  const [btc, eth] = byPair(rows, () => 0);
  assert.deepEqual([btc.pool, btc.closes, btc.wins, btc.pnl, btc.volume], ['btc', 2, 2, p(30), 430]);
  assert.deepEqual([eth.pool, eth.closes, eth.wins, eth.pnl], ['eth', 1, 0, -p(10)]);

  assert.deepEqual(activity(rows), { trades: 4, days: 2, entries: 3, longs: 2, hold: 600, last: 90600 });
});
