// The one Offshift strategy, as pure functions so a restart can recompute every decision.
// BTC trend: long while the 10-minute average of 1-minute closes is above the 30-minute
// average, short while below. Inside a 0.05% band it holds what it has. A loss of 1.5% from
// entry closes the position and blocks that side until the trend flips.

export const FAST = 10;
export const SLOW = 30;
export const BAND = 0.0005;
export const STOP_LOSS = 0.015;

export function ema(values, n) {
  const k = 2 / (n + 1);
  return values.reduce((avg, v, i) => (i === 0 ? v : v * k + avg * (1 - k)));
}

// closes: oldest first, at least SLOW values. Returns 'long', 'short' or 'hold'.
export function trend(closes) {
  if (closes.length < SLOW) return 'hold';
  const fast = ema(closes.slice(-SLOW), FAST);
  const slow = ema(closes.slice(-SLOW), SLOW);
  if (Math.abs(fast - slow) / slow < BAND) return 'hold';
  return fast > slow ? 'long' : 'short';
}

// The position the session should hold, in signed base units.
// size: current signed position; qty: the session's unit size; entry/mark: prices as numbers.
// blocked: side closed by the stop loss, or null. Returns { target, blocked }.
export function decide({ size, qty, closes, entry, mark, ending, blocked }) {
  if (ending) return { target: 0n, blocked };
  const side = size > 0n ? 'long' : size < 0n ? 'short' : null;
  if (side && entry > 0) {
    const pnl = side === 'long' ? mark / entry - 1 : 1 - mark / entry;
    if (pnl <= -STOP_LOSS) return { target: 0n, blocked: side };
  }
  const t = trend(closes);
  if (blocked && t !== 'hold' && t !== blocked) blocked = null; // the trend flipped
  if (t === 'hold') return { target: size, blocked };
  if (t === blocked) return { target: 0n, blocked };
  return { target: t === 'long' ? qty : -qty, blocked };
}

// Follow a trader: hold the trader's side at the shift's size (fixed size, not their ratio).
// Exits and flips to flat always copy; an entry is skipped once price is more than TOLERANCE
// past the trader's entry, so a late follower never buys the trader's move from them.
export const TOLERANCE = 0.005;
export function follow({ size, qty, leader, leaderEntry, mark, ending }) {
  if (ending || leader === 0n) return { target: 0n, skip: false };
  const side = leader > 0n ? 1n : -1n;
  if (size * side > 0n) return { target: size, skip: false }; // already on the trader's side
  const worse = side > 0n ? mark / leaderEntry - 1 : 1 - mark / leaderEntry;
  return worse > TOLERANCE ? { target: 0n, skip: true } : { target: side * qty, skip: false };
}

// What following a trader would have realized at `notional` USDso a trade: their position changes,
// oldest first, replayed through follow() at their own fill prices. An estimate: it leaves out fees,
// funding, slippage, the shift's loss limit and the seconds a copy takes.
const price = (raw) => Number(raw ?? 0n) / 1e18;
const units = (n) => Number(n < 0n ? -n : n);
export function fillPrice(c) {
  if (c.exitPrice) return price(c.exitPrice);
  const before = units(c.sizeBefore), after = units(c.sizeAfter);
  return (price(c.entryPriceAfter) * after - price(c.entryPriceBefore) * before) / (after - before);
}
export function replay(changes, notional) {
  let size = 0n, entry = 0, pnl = 0, trades = 0;
  for (const c of changes) {
    const fill = fillPrice(c);
    const { target } = follow({ size, qty: 1n, leader: c.sizeAfter, leaderEntry: price(c.entryPriceAfter), mark: fill, ending: false });
    if (target === size) continue;
    if (size !== 0n) {
      pnl += notional * (fill / entry - 1) * Number(size);
      trades += 1;
    }
    size = target;
    entry = fill;
  }
  return { pnl, trades };
}
