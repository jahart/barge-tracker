import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTrend } from './compute-trend.mjs';

const USGS_URL =
  'https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json';
const NWS_URL = 'https://api.water.noaa.gov/nwps/v1/gauges/parw2';

async function fetchStageAndTrend() {
  const res = await fetch(USGS_URL);
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);

  const data = await res.json();
  const values = data.value?.timeSeries?.[0]?.values?.[0]?.value;
  if (!values || values.length === 0) {
    throw new Error('USGS response has no stage values');
  }

  const oldestFt = parseFloat(values[0].value);
  const newestFt = parseFloat(values[values.length - 1].value);
  if (!Number.isFinite(oldestFt) || !Number.isFinite(newestFt)) {
    throw new Error('USGS response has non-numeric stage values');
  }

  return { stageFt: newestFt, trend: computeTrend(oldestFt, newestFt) };
}

async function fetchFloodCategory() {
  const res = await fetch(NWS_URL);
  if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);

  const data = await res.json();
  const category = data.status?.observed?.floodCategory;
  if (!category) throw new Error('NWS response missing floodCategory');

  return category;
}

async function main() {
  const [{ stageFt, trend }, floodCategory] = await Promise.all([
    fetchStageAndTrend(),
    fetchFloodCategory(),
  ]);

  const output = {
    stageFt,
    trend,
    floodCategory,
    updated: new Date().toISOString(),
  };

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  writeFileSync(join(repoRoot, 'river.json'), JSON.stringify(output, null, 2) + '\n');

  console.log('Wrote river.json:', output);
}

main().catch((err) => {
  console.error('Failed to update river conditions:', err);
  process.exit(1);
});
