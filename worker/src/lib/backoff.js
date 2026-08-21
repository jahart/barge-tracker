export const INITIAL_DELAY_MS = 5000;
export const MAX_DELAY_MS = 5 * 60 * 1000;

export function nextDelay(currentDelayMs) {
  return Math.min(currentDelayMs * 2, MAX_DELAY_MS);
}
