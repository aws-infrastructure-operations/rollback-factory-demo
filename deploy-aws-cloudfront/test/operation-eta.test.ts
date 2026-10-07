import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { etaText, formatDuration } from '../app/src/eta.js';

const estimate = { ms: 12_000, from: 'history' as const, runs: 5 };

test('formats durations as m:ss', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(7_400), '0:07');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(-500), '0:00');
});

test('counts down to the usual duration, then says it is taking longer, then how long it took', () => {
  assert.equal(etaText(5_000, undefined, false), 'Elapsed 0:05');
  assert.equal(etaText(5_000, estimate, false), 'Elapsed 0:05 · about 0:07 left');
  assert.equal(etaText(15_000, estimate, false), 'Elapsed 0:15 · taking longer than usual (usually ~0:12)');
  assert.equal(etaText(14_000, estimate, true), 'Took 0:14');
});
