import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, follow, replay, trend } from './strategy.mjs';

const up = Array.from({ length: 30 }, (_, i) => 80000 + i * 20);
const down = [...up].reverse();
const flat = Array(30).fill(80000);
const base = { qty: 100n, entry: 0, mark: 80000, ending: false, blocked: null };

test('trend follows the averages and holds inside the band', () => {
  assert.equal(trend(up), 'long');
  assert.equal(trend(down), 'short');
  assert.equal(trend(flat), 'hold');
  assert.equal(trend(up.slice(1)), 'hold'); // not enough closes yet
});

test('targets: enter, flip, hold, and go flat at the end', () => {
  assert.equal(decide({ ...base, size: 0n, closes: up }).target, 100n);
  assert.equal(decide({ ...base, size: 100n, entry: 80000, closes: down }).target, -100n);
  assert.equal(decide({ ...base, size: 100n, entry: 80000, closes: flat }).target, 100n);
  assert.equal(decide({ ...base, size: -100n, entry: 80000, closes: down, ending: true }).target, 0n);
});

test('stop loss closes and blocks that side until the trend flips', () => {
  const stopped = decide({ ...base, size: 100n, entry: 80000, mark: 78700, closes: up });
  assert.deepEqual(stopped, { target: 0n, blocked: 'long' });
  assert.equal(decide({ ...base, size: 0n, closes: up, blocked: 'long' }).target, 0n);
  assert.deepEqual(decide({ ...base, size: 0n, closes: flat, blocked: 'long' }), { target: 0n, blocked: 'long' });
  assert.deepEqual(decide({ ...base, size: 0n, closes: down, blocked: 'long' }), { target: -100n, blocked: null });
});

test('follow: copy the side within tolerance, skip late entries, always exit', () => {
  const f = { qty: 100n, leaderEntry: 80000, ending: false };
  assert.deepEqual(follow({ ...f, size: 0n, leader: 5n, mark: 80200 }), { target: 100n, skip: false });
  assert.deepEqual(follow({ ...f, size: 0n, leader: 5n, mark: 80500 }), { target: 0n, skip: true });
  assert.deepEqual(follow({ ...f, size: 0n, leader: -5n, mark: 80500 }), { target: -100n, skip: false }); // price moved in the short's favour
  assert.deepEqual(follow({ ...f, size: 100n, leader: -5n, mark: 79000 }), { target: 0n, skip: true }); // flip: close, too late to enter
  assert.equal(follow({ ...f, size: 100n, leader: 0n, mark: 80000 }).target, 0n);
  assert.equal(follow({ ...f, size: 100n, leader: 5n, mark: 90000 }).target, 100n); // hold, however far price ran
});

test('replay: fixed size at the trader\'s fills, holding through their adds and flips', () => {
  const p = (n) => BigInt(n) * 10n ** 18n;
  const change = (sizeBefore, sizeAfter, entryPriceBefore, entryPriceAfter, exitPrice = null) => ({ sizeBefore, sizeAfter, entryPriceBefore, entryPriceAfter, exitPrice });
  const { pnl, trades } = replay([
    change(0n, 5n, null, p(100)), // opens long at 100
    change(5n, 10n, p(100), p(105)), // adds at 110: same side, nothing to copy
    change(10n, -5n, p(105), p(120), p(120)), // flips short at 120: +20% on the long
    change(-5n, 0n, p(120), 0n, p(114)), // covers at 114: +5% on the short
  ], 20);
  assert.equal(trades, 2);
  assert.ok(Math.abs(pnl - 5) < 1e-9);
});
