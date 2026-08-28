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

test('sorts by endOfLockage descending instead of trusting response order', () => {
  const raw = [
    {
      vesselName: 'OLDEST',
      vesselNo: '1',
      direction: 'U',
      numBarges: 1,
      SOLdate: '08/08/26 10:00',
      arrivalDate: '08/08/26 09:00',
      endOfLockage: '08/08/26 11:00',
      timezone: 'EST',
      MMSI: 111,
    },
    {
      vesselName: 'NEWEST',
      vesselNo: '2',
      direction: 'U',
      numBarges: 1,
      SOLdate: '08/28/26 10:00',
      arrivalDate: '08/28/26 09:00',
      endOfLockage: '08/28/26 11:00',
      timezone: 'EST',
      MMSI: 222,
    },
    {
      vesselName: 'MIDDLE',
      vesselNo: '3',
      direction: 'U',
      numBarges: 1,
      SOLdate: '08/19/26 10:00',
      arrivalDate: '08/19/26 09:00',
      endOfLockage: '08/19/26 11:00',
      timezone: 'EST',
      MMSI: 333,
    },
  ];

  const result = shapeLockQueue(raw);

  assert.deepEqual(
    result.recentLockages.map((l) => l.vesselName),
    ['NEWEST', 'MIDDLE', 'OLDEST']
  );
});

test('handles an empty array (no lockages in the past 30 days)', () => {
  const result = shapeLockQueue([]);
  assert.deepEqual(result.recentLockages, []);
});

test('skips in-progress lockages (vessel still at the lock, endOfLockage not yet set)', () => {
  const result = shapeLockQueue([
    {
      vesselName: 'THOMAS E. ERICKSON',
      vesselNo: '0581142',
      direction: 'U',
      numBarges: 15,
      SOLdate: null,
      arrivalDate: '08/26/26 16:04',
      endOfLockage: null,
      timezone: 'EST',
      MMSI: 367638210,
    },
    {
      vesselName: 'M/V KEVIN MICHAEL',
      vesselNo: '0273675',
      direction: 'U',
      numBarges: 14,
      SOLdate: '08/26/26 15:06',
      arrivalDate: '08/26/26 14:37',
      endOfLockage: '08/26/26 16:30',
      timezone: 'EST',
      MMSI: 368416120,
    },
  ]);

  assert.equal(result.recentLockages.length, 1);
  assert.equal(result.recentLockages[0].vesselName, 'M/V KEVIN MICHAEL');
});
