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
