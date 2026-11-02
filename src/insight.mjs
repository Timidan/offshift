// What a trader's position changes say about them. Pure, so it can be checked without the indexer.
import { fillPrice } from './strategy.mjs';

const abs = (n) => (n < 0n ? -n : n);

// One row per closed order: an order that fills across several price levels arrives as one change per fill.
export function closedOrders(rows) {
  const orders = new Map();
  for (const c of rows) {
    if (!c.closedSize) continue;
    const key = c.orderId ?? c.id, o = orders.get(key);
    if (o) {
      o.pnl += c.realizedPnl;
      o.size += c.closedSize;
      o.at = c.timestamp;
      o.value += c.exitPrice * c.closedSize;
    } else orders.set(key, { pool: c.pool, at: c.timestamp, long: c.sizeBefore > 0n, size: c.closedSize, entry: c.entryPriceBefore, value: c.exitPrice * c.closedSize, pnl: c.realizedPnl });
  }
  return [...orders.values()].map(({ value, ...o }) => ({ ...o, exit: value / o.size })); // the order's average exit
}

// Volume, closes and realized PnL per market, busiest first.
export function byPair(rows, baseDecimals) {
  const pairs = new Map();
  for (const c of rows) {
    const p = pairs.get(c.pool) ?? { pool: c.pool, closes: 0, wins: 0, pnl: 0n, volume: 0 };
    p.volume += (Number(abs(c.sizeAfter - c.sizeBefore)) / 10 ** baseDecimals(c.pool)) * fillPrice(c);
    if (c.closedSize) {
      p.closes += 1;
      p.pnl += c.realizedPnl;
      if (c.realizedPnl > 0n) p.wins += 1;
    }
    pairs.set(c.pool, p);
  }
  return [...pairs.values()].sort((a, b) => b.volume - a.volume);
}

// How they trade: orders placed, days active, the side they enter on and how long they usually hold.
export function activity(rows) {
  const orders = new Set(), days = new Set(), opened = new Map(), holds = [];
  let entries = 0, longs = 0;
  for (const c of rows) {
    const at = Number(c.timestamp);
    orders.add(c.orderId ?? c.id);
    days.add(Math.floor(at / 86_400));
    if ((c.kind === 'CLOSE' || c.kind === 'FLIP') && opened.has(c.pool)) {
      holds.push(at - opened.get(c.pool));
      opened.delete(c.pool);
    }
    if (c.kind === 'OPEN' || c.kind === 'FLIP') {
      opened.set(c.pool, at);
      entries += 1;
      if (c.sizeAfter > 0n) longs += 1;
    }
  }
  holds.sort((a, b) => a - b);
  return { trades: orders.size, days: days.size, entries, longs, hold: holds[holds.length >> 1] ?? null, last: Number(rows.at(-1)?.timestamp ?? 0) };
}
