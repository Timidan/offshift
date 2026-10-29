import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, trend } from './strategy.mjs';

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
