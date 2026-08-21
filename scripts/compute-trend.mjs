const STEADY_BAND_FT = 0.05;

export function computeTrend(oldestFt, newestFt) {
  // Round to avoid floating-point noise (e.g. 25.00 - 25.05 === -0.05000000000000071)
  // misclassifying values that are meant to land exactly on the steady-band boundary.
  const delta = Math.round((newestFt - oldestFt) * 1000) / 1000;
  if (delta > STEADY_BAND_FT) return 'rising';
  if (delta < -STEADY_BAND_FT) return 'falling';
  return 'steady';
}
