import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrend } from './compute-trend.mjs';

test('classifies a rising stage', () => {
  assert.equal(computeTrend(25.0, 25.2), 'rising');
});

test('classifies a falling stage', () => {
  assert.equal(computeTrend(25.2, 25.0), 'falling');
});

test('classifies a steady stage within the dead-band', () => {
  assert.equal(computeTrend(25.10, 25.13), 'steady');
});

test('treats exactly +0.05 ft as steady (boundary, not rising)', () => {
  assert.equal(computeTrend(25.00, 25.05), 'steady');
});

test('treats exactly -0.05 ft as steady (boundary, not falling)', () => {
  assert.equal(computeTrend(25.05, 25.00), 'steady');
});

test('classifies just past the rising boundary', () => {
  assert.equal(computeTrend(25.00, 25.06), 'rising');
});
