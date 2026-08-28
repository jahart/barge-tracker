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
  // Vessels currently at the lock but not yet cleared have a null
  // endOfLockage (confirmed against real data) — this feed is documented as
  // completed lockages, so in-progress entries are skipped rather than shown
  // with a fabricated timestamp.
  const recentLockages = rawArray
    .filter((entry) => entry.endOfLockage !== null)
    .map((entry) => ({
      vesselName: entry.vesselName,
      direction: entry.direction,
      numBarges: entry.numBarges,
      endOfLockage: toIso8601(entry.endOfLockage),
      mmsi: entry.MMSI,
    }))
    // USACE doesn't guarantee newest-first order (confirmed: the same query
    // returned entries out of chronological order across live calls) — sort
    // explicitly rather than trusting response order.
    .sort((a, b) => Date.parse(b.endOfLockage) - Date.parse(a.endOfLockage))
    .slice(0, LOCKAGE_LIMIT);

  return { recentLockages };
}
