export const STALE_THRESHOLD_MS = 10 * 60 * 1000;

export function parsePositionReport(msg, now) {
  if (!msg || msg.MessageType !== 'PositionReport') return null;

  const pos = msg.Message && msg.Message.PositionReport;
  if (!pos) return null;

  const meta = msg.MetaData || {};
  const name = (meta.ShipName || '').trim();

  return {
    mmsi: String(pos.UserID),
    name: name || `MMSI ${pos.UserID}`,
    lat: pos.Latitude,
    lon: pos.Longitude,
    sog: pos.Sog,
    cog: pos.Cog,
    updatedAt: now,
  };
}

export function findStale(vessels, now, thresholdMs = STALE_THRESHOLD_MS) {
  const stale = [];
  for (const [mmsi, vessel] of vessels) {
    if (now - vessel.updatedAt > thresholdMs) stale.push(mmsi);
  }
  return stale;
}
