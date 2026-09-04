import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeLockQueue } from './shape-lock-traffic.mjs';

test('normalizes USACE MM/DD/YY date format to ISO-8601 using the offset actually in effect', () => {
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

  assert.equal(result.recentLockages[0].endOfLockage, '2026-08-11T20:48:00-04:00');
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
    endOfLockage: '2026-08-19T04:24:00-04:00',
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

// The feed labels every entry "EST" year-round, so these cases pin the real
// DST behavior: the wall-clock string is local time at the lock, and the
// offset must follow the calendar, not the (useless) timezone field.
const isoFor = (endOfLockage) =>
  shapeLockQueue([
    {
      vesselName: 'TEST TOW',
      vesselNo: '1',
      direction: 'U',
      numBarges: 1,
      SOLdate: endOfLockage,
      arrivalDate: endOfLockage,
      endOfLockage,
      timezone: 'EST',
      MMSI: 1,
    },
  ]).recentLockages[0].endOfLockage;

test('uses EDT (-04:00) for a summer lockage despite the feed claiming EST', () => {
  assert.equal(isoFor('09/03/26 15:19'), '2026-09-03T15:19:00-04:00');
  assert.equal(Date.parse(isoFor('09/03/26 15:19')), Date.parse('2026-09-03T19:19:00Z'));
});

test('uses EST (-05:00) for a winter lockage', () => {
  assert.equal(isoFor('01/15/26 10:00'), '2026-01-15T10:00:00-05:00');
  assert.equal(Date.parse(isoFor('01/15/26 10:00')), Date.parse('2026-01-15T15:00:00Z'));
});

test('switches offset across the spring-forward boundary (2026-03-08)', () => {
  assert.equal(isoFor('03/08/26 01:30'), '2026-03-08T01:30:00-05:00');
  assert.equal(isoFor('03/08/26 03:30'), '2026-03-08T03:30:00-04:00');
});

test('normalizes a nonexistent spring-forward wall clock to a real instant', () => {
  // 02:30 local never happens on 2026-03-08 — the clock jumps 02:00 -> 03:00.
  // Rendering from the resolved instant yields a real local time rather than
  // echoing back a reading that cannot exist.
  const iso = isoFor('03/08/26 02:30');
  assert.equal(iso, '2026-03-08T01:30:00-05:00');
  assert.ok(Number.isFinite(Date.parse(iso)));
});

test('resolves an ambiguous fall-back wall clock deterministically (2026-11-01)', () => {
  // 01:30 local occurs twice; the first (still-EDT) occurrence is chosen.
  assert.equal(isoFor('11/01/26 01:30'), '2026-11-01T01:30:00-04:00');
  assert.equal(isoFor('11/01/26 03:30'), '2026-11-01T03:30:00-05:00');
});

test('handles a midnight reading (ICU may render hour 24 under hour12:false)', () => {
  assert.equal(isoFor('07/04/26 00:00'), '2026-07-04T00:00:00-04:00');
});
