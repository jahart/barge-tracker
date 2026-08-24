import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTrend } from './compute-trend.mjs';

const USGS_URL =
  'https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json';
const NWS_URL = 'https://api.water.noaa.gov/nwps/v1/gauges/parw2';

const FETCH_TIMEOUT_MS = 10_000;
const RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

async function fetchStageAndTrend() {
  return withRetry(async () => {
    const data = await fetchJson(USGS_URL);
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
  });
}

async function fetchFloodCategory() {
  return withRetry(async () => {
    const data = await fetchJson(NWS_URL);
    const category = data.status?.observed?.floodCategory;
    if (!category) throw new Error('NWS response missing floodCategory');
    return category;
  });
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
