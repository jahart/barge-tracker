const LOCKAGE_LIMIT = 5;

// USACE's lock_queue_json stamps every entry's `timezone` field "EST"
// regardless of time of year (confirmed against real August and September
// data, when the Ohio valley is on EDT), so that field is not usable. The
// wall-clock string itself is plain local time at the lock, which means it
// needs a real DST-aware conversion rather than the fixed UTC-5 offset this
// used to apply — that made every lockage read one hour later than it
// happened, and pushed the frontend's derived ETA an hour into the future.
const LOCK_TIME_ZONE = 'America/New_York';

// UTC offset (ms, negative west of UTC) that LOCK_TIME_ZONE was observing at
// the given instant. Derived by formatting the instant in the zone and
// re-reading those wall-clock parts as if they were UTC.
function zoneOffsetMs(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instantMs);

  const p = {};
  for (const { type, value } of parts) p[type] = value;

  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    // Some ICU versions render midnight as hour "24" under hour12:false.
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );

  return asUtc - instantMs;
}

// Resolve a local wall-clock reading to a real UTC instant. Two passes: the
// first offset lookup is done at the wrong instant (off by the offset
// itself), and the second lookup — now within an hour of the truth —
// converges, including across a DST boundary.
function wallClockToInstantMs(year, month, day, hour, minute, timeZone) {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = zoneOffsetMs(naiveUtc, timeZone);
  const offset = zoneOffsetMs(naiveUtc - firstGuess, timeZone);
  return naiveUtc - offset;
}

function formatOffset(offsetMs) {
  const sign = offsetMs < 0 ? '-' : '+';
  const abs = Math.abs(offsetMs);
  const hours = String(Math.floor(abs / 3_600_000)).padStart(2, '0');
  const mins = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

function toIso8601(usaceDateStr) {
  const [datePart, timePart] = usaceDateStr.split(' ');
  const [month, day, yy] = datePart.split('/');
  const [hour, minute] = timePart.split(':');

  const instantMs = wallClockToInstantMs(
    2000 + Number(yy),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    LOCK_TIME_ZONE
  );

  // Render the wall clock that actually corresponds to the resolved instant,
  // rather than echoing the input, so a nonexistent spring-forward reading
  // normalizes to a real local time instead of emitting a bogus string.
  const offsetMs = zoneOffsetMs(instantMs, LOCK_TIME_ZONE);
  const localWallClock = new Date(instantMs + offsetMs).toISOString().slice(0, 19);

  return `${localWallClock}${formatOffset(offsetMs)}`;
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
