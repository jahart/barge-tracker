import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTrend } from './compute-trend.mjs';
import { fetchJson, withRetry } from './lib/fetch-with-retry.mjs';

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

const USGS_URL =
  'https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json';
const NWS_URL = 'https://api.water.noaa.gov/nwps/v1/gauges/parw2';
// Parkersburg has no water-temperature sensor; Wheeling is the nearest Ohio
// River mainstem gauge that reports one (~90 river miles upstream).
const WATER_TEMP_URL =
  'https://waterservices.usgs.gov/nwis/iv/?sites=03112500&parameterCd=00010&period=PT6H&format=json';
// Mid-Ohio Valley Regional Airport, Parkersburg
const AIR_TEMP_URL = 'https://api.weather.gov/stations/KPKB/observations/latest';
// api.weather.gov rejects requests without a User-Agent
const NWS_HEADERS = { 'User-Agent': 'barge-tracker (github.com/jahart/barge-tracker)' };

const cToF = (c) => Math.round((c * 9) / 5 + 32);

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

async function fetchWaterTempF() {
  return withRetry(async () => {
    const data = await fetchJson(WATER_TEMP_URL);
    const values = data.value?.timeSeries?.[0]?.values?.[0]?.value;
    const c = parseFloat(values?.[values.length - 1]?.value);
    if (!Number.isFinite(c)) throw new Error('USGS response has no water temperature');
    return cToF(c);
  });
}

async function fetchAirTempF() {
  return withRetry(async () => {
    const data = await fetchJson(AIR_TEMP_URL, { headers: NWS_HEADERS });
    const c = data.properties?.temperature?.value;
    if (!Number.isFinite(c)) throw new Error('NWS observation has no air temperature');
    return cToF(c);
  });
}

// Temperatures are nice-to-have: a failure writes null rather than blocking
// the stage/flood update.
async function orNull(promise, label) {
  try {
    return await promise;
  } catch (err) {
    console.warn(`Could not fetch ${label}:`, err.message);
    return null;
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const riverJsonPath = join(repoRoot, 'river.json');

function lastUpdateAgeMs() {
  const existing = JSON.parse(readFileSync(riverJsonPath, 'utf8'));
  return Date.now() - Date.parse(existing.updated);
}

async function main() {
  const [{ stageFt, trend }, floodCategory, airTempF, waterTempF] = await Promise.all([
    fetchStageAndTrend(),
    fetchFloodCategory(),
    orNull(fetchAirTempF(), 'air temperature'),
    orNull(fetchWaterTempF(), 'water temperature'),
  ]);

  const output = {
    stageFt,
    trend,
    floodCategory,
    airTempF,
    waterTempF,
    updated: new Date().toISOString(),
  };

  writeFileSync(riverJsonPath, JSON.stringify(output, null, 2) + '\n');

  console.log('Wrote river.json:', output);
}

main().catch((err) => {
  console.error('Failed to update river conditions:', err);

  let ageMs;
  try {
    ageMs = lastUpdateAgeMs();
  } catch {
    ageMs = Infinity; // no prior data to fall back on — treat as a real outage
  }

  if (ageMs < STALE_THRESHOLD_MS) {
    console.warn(
      `river.json is only ${Math.round(ageMs / 60_000)}m old — within the ${STALE_THRESHOLD_MS / 3_600_000}h tolerance, not failing the job.`
    );
    process.exit(0);
  }

  console.error(`river.json has been stale for over ${STALE_THRESHOLD_MS / 3_600_000}h — failing the job.`);
  process.exit(1);
});
