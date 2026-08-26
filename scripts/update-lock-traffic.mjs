import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchJson, withRetry } from './lib/fetch-with-retry.mjs';
import { shapeLockQueue } from './shape-lock-traffic.mjs';

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

const LOCKS = [
  { key: 'belleville', name: 'Belleville Locks and Dam', lockNo: '21' },
  { key: 'willowIsland', name: 'Willow Island Locks and Dam', lockNo: '72' },
];

const lockQueueUrl = (lockNo) =>
  `https://ndc.ops.usace.army.mil/ords/lpms/json/lock_queue_json?in_river=OH&in_lock=${lockNo}`;

async function fetchLockQueue(lockNo) {
  return withRetry(async () => {
    const data = await fetchJson(lockQueueUrl(lockNo));
    if (!Array.isArray(data)) {
      throw new Error(`Lock ${lockNo} response is not an array`);
    }
    return data;
  });
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockTrafficJsonPath = join(repoRoot, 'lock-traffic.json');

function lastUpdateAgeMs() {
  const existing = JSON.parse(readFileSync(lockTrafficJsonPath, 'utf8'));
  return Date.now() - Date.parse(existing.updated);
}

async function main() {
  const entries = await Promise.all(
    LOCKS.map(async (lock) => {
      const raw = await fetchLockQueue(lock.lockNo);
      return [lock.key, { name: lock.name, ...shapeLockQueue(raw) }];
    })
  );

  const output = {
    updated: new Date().toISOString(),
    locks: Object.fromEntries(entries),
  };

  writeFileSync(lockTrafficJsonPath, JSON.stringify(output, null, 2) + '\n');

  console.log('Wrote lock-traffic.json:', output);
}

main().catch((err) => {
  console.error('Failed to update lock traffic:', err);

  let ageMs;
  try {
    ageMs = lastUpdateAgeMs();
  } catch {
    ageMs = Infinity; // no prior data to fall back on — treat as a real outage
  }

  if (ageMs < STALE_THRESHOLD_MS) {
    console.warn(
      `lock-traffic.json is only ${Math.round(ageMs / 60_000)}m old — within the ${STALE_THRESHOLD_MS / 3_600_000}h tolerance, not failing the job.`
    );
    process.exit(0);
  }

  console.error(`lock-traffic.json has been stale for over ${STALE_THRESHOLD_MS / 3_600_000}h — failing the job.`);
  process.exit(1);
});
