import { describe, it, expect } from 'vitest';
import { parsePositionReport, findStale, STALE_THRESHOLD_MS } from '../src/lib/vessels.js';

describe('parsePositionReport', () => {
  it('returns null for non-PositionReport messages', () => {
    expect(parsePositionReport({ MessageType: 'ShipStaticData' }, 1000)).toBeNull();
  });

  it('parses a PositionReport into a vessel object', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { ShipName: '  M/V EXAMPLE  ' },
      Message: {
        PositionReport: { UserID: 123456789, Latitude: 39.2, Longitude: -81.5, Sog: 5.2, Cog: 180 },
      },
    };
    expect(parsePositionReport(msg, 1000)).toEqual({
      mmsi: '123456789',
      name: 'M/V EXAMPLE',
      lat: 39.2,
      lon: -81.5,
      sog: 5.2,
      cog: 180,
      updatedAt: 1000,
    });
  });

  it('falls back to "MMSI <id>" when ShipName is blank', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { ShipName: '   ' },
      Message: {
        PositionReport: { UserID: 987654321, Latitude: 39.3, Longitude: -81.4, Sog: 0, Cog: 0 },
      },
    };
    expect(parsePositionReport(msg, 1000).name).toBe('MMSI 987654321');
  });
});

describe('findStale', () => {
  it('returns nothing when all vessels are within the threshold', () => {
    const vessels = new Map([
      ['1', { mmsi: '1', updatedAt: 0 }],
      ['2', { mmsi: '2', updatedAt: 9000 }],
    ]);
    expect(findStale(vessels, 10000, STALE_THRESHOLD_MS)).toEqual([]);
  });

  it('returns mmsi of vessels older than the threshold', () => {
    const vessels = new Map([
      ['1', { mmsi: '1', updatedAt: 0 }],
      ['2', { mmsi: '2', updatedAt: 9000 }],
    ]);
    const now = 9000 + STALE_THRESHOLD_MS + 1;
    expect(findStale(vessels, now, STALE_THRESHOLD_MS)).toEqual(['1', '2']);
  });

  it('keeps a vessel exactly at the threshold', () => {
    const vessels = new Map([['1', { mmsi: '1', updatedAt: 1000 }]]);
    expect(findStale(vessels, 1000 + STALE_THRESHOLD_MS, STALE_THRESHOLD_MS)).toEqual([]);
  });
});
