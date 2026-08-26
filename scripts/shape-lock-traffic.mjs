const LOCKAGE_LIMIT = 5;

// USACE's lock_queue_json labels every timestamp "EST" regardless of time of
// year (confirmed against real August data during design) — it's not
// DST-aware, so this is a fixed UTC-5 offset, not a real IANA zone lookup.
function toIso8601(usaceDateStr) {
  const [datePart, timePart] = usaceDateStr.split(' ');
  const [month, day, yy] = datePart.split('/');
  const year = 2000 + Number(yy);
  return `${year}-${month}-${day}T${timePart}:00-05:00`;
}

export function shapeLockQueue(rawArray) {
  const recentLockages = rawArray.slice(0, LOCKAGE_LIMIT).map((entry) => ({
    vesselName: entry.vesselName,
    direction: entry.direction,
    numBarges: entry.numBarges,
    endOfLockage: toIso8601(entry.endOfLockage),
    mmsi: entry.MMSI,
  }));

  return { recentLockages };
}
