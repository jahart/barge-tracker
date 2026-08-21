import { describe, it, expect } from 'vitest';
import { INITIAL_DELAY_MS, MAX_DELAY_MS, nextDelay } from '../src/lib/backoff.js';

describe('nextDelay', () => {
  it('doubles the current delay', () => {
    expect(nextDelay(INITIAL_DELAY_MS)).toBe(INITIAL_DELAY_MS * 2);
  });

  it('caps a value that would double past the max', () => {
    expect(nextDelay(4 * 60 * 1000)).toBe(MAX_DELAY_MS);
  });

  it('stays capped once already at the max', () => {
    expect(nextDelay(MAX_DELAY_MS)).toBe(MAX_DELAY_MS);
  });
});
