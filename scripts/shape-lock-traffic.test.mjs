import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeLockQueue } from './shape-lock-traffic.mjs';

test('normalizes USACE MM/DD/YY date format to ISO-8601 with a fixed UTC-5 offset', () => {
  const result = shapeLockQueue([
    {
      vesselName: 'GLENN A HENDON',
      vesselNo: '0625977',
      direction: 'U',
      numBarges: 11,
      SOLdate: '08/11/26 20:09',
      arrivalDate: '08/11/26 19:20',
      endOfLockage: '08/11/26 20:48',
      timezone: 'EST',
      MMSI: 367375080,
    },
  ]);

  assert.equal(result.recentLockages[0].endOfLockage, '2026-08-11T20:48:00-05:00');
});

test('passes through vesselName, direction, numBarges, and mmsi unchanged', () => {
  const result = shapeLockQueue([
    {
      vesselName: 'CANTON',
      vesselNo: '1224197',
      direction: 'D',
      numBarges: 6,
      SOLdate: '08/19/26 03:06',
      arrivalDate: '08/19/26 03:05',
      endOfLockage: '08/19/26 04:24',
      timezone: 'EST',
      MMSI: 367433690,
    },
  ]);

  assert.deepEqual(result.recentLockages[0], {
    vesselName: 'CANTON',
    direction: 'D',
    numBarges: 6,
    endOfLockage: '2026-08-19T04:24:00-05:00',
    mmsi: 367433690,
  });
});

test('caps recentLockages at the 5 most recent entries, preserving newest-first order', () => {
  const raw = Array.from({ length: 8 }, (_, i) => ({
    vesselName: `VESSEL ${i}`,
    vesselNo: String(i),
    direction: 'U',
    numBarges: 1,
    SOLdate: '08/19/26 04:00',
    arrivalDate: '08/19/26 03:55',
    endOfLockage: '08/19/26 04:24',
    timezone: 'EST',
    MMSI: 100000 + i,
  }));

  const result = shapeLockQueue(raw);

  assert.equal(result.recentLockages.length, 5);
  assert.equal(result.recentLockages[0].vesselName, 'VESSEL 0');
  assert.equal(result.recentLockages[4].vesselName, 'VESSEL 4');
});

test('handles an empty array (no lockages in the past 30 days)', () => {
  const result = shapeLockQueue([]);
  assert.deepEqual(result.recentLockages, []);
});
