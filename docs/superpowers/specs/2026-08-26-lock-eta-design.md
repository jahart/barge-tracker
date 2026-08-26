# Lock Traffic ETA — Live Countdown to OVRC

Design spec for adding a rough, live-updating "ETA to OVRC Launch" to the Traffic Log tab's Lock Traffic panel ([`docs/superpowers/specs/2026-08-26-lock-traffic-design.md`](2026-08-26-lock-traffic-design.md), just shipped). User request, verbatim: "can the traffic log provide an estimate of when the barge from the locks will be approaching the dock? like eta or something, does not have to be accurate just a heads up... can it use the current time to 'estimate' so something like eta by dock in 20 mins, and keep counting down?"

Explicitly **not required to be accurate** — this is a rough heads-up derived from a completed-lockage timestamp and an assumed cruising speed, not a real-time detection. It must not be visually confused with the real AIS danger-zone alert, which is based on live vessel position.

## Problem

The Lock Traffic panel currently shows each recent lockage as "↑ VESSEL NAME — 11 barges · 2h ago." That tells you a vessel passed a lock, but not when it might reach OVRC Launch — the number a rower actually needs before heading out. This ETA is always shown, regardless of whether the live AIS feed is currently connected — it's a permanent complement to AIS (same "keep it even once AIS is confirmed working" decision as the rest of the Lock Traffic panel, [`2026-08-26-lock-traffic-design.md`](2026-08-26-lock-traffic-design.md)), not a fallback that only appears when AIS is down. When AIS is working, this gives a second, independently-sourced check on the same vessel; when it isn't ([`2026-08-21-phase1-ais-relay-design.md`](2026-08-21-phase1-ais-relay-design.md)'s open issue), it's the only heads-up available.

## Scope: frontend-only

No changes to `lock-traffic.json`, `scripts/update-lock-traffic.mjs`, or the GitHub Actions workflow. Everything needed is already in `lock-traffic.json` (`endOfLockage`) and already defined in `index.html` (`OVRC`, `BELLEVILLE`, `WILLOW_ISLAND`, `distanceM()`).

## Which lockages get an ETA

Only the direction that heads toward OVRC gets one, matching the existing `approachSource()` convention already used for live AIS vessels:

| Lock | Direction toward OVRC | Direction away (no ETA) |
|---|---|---|
| Belleville | `U` (upbound) | `D` |
| Willow Island | `D` (downbound) | `U` |

A lockage in the away-from-OVRC direction keeps today's exact display: `${numBarges} barges · ${timeAgo}`. There is nothing to estimate for a vessel moving away from the tracked stretch.

## Computing the estimate

```js
const ASSUMED_TOW_SPEED_MPS = 8 * 0.44704; // 8 mph, a round-number typical towboat cruising speed — this is explicitly a rough estimate, not measured data

const LOCK_APPROACH_DIRECTION = { belleville: 'U', willowIsland: 'D' };

const LOCK_DISTANCE_M = {
  belleville: distanceM(BELLEVILLE, OVRC),
  willowIsland: distanceM(WILLOW_ISLAND, OVRC),
};
```

For an approaching lockage: `estimatedArrivalMs = Date.parse(lockage.endOfLockage) + (LOCK_DISTANCE_M[key] / ASSUMED_TOW_SPEED_MPS) * 1000`.

Straight-line distance (`distanceM()`, already used for the live AIS ETA in `etaMinutes()`) is reused rather than introducing a river-following distance — consistent with how the app already approximates distance elsewhere, and irrelevant to precision given the assumed-speed estimate is already rough. At today's real data, this puts fresh lockages at roughly a 1.5–2 hour estimated transit (~15 miles at 8 mph), confirmed against real coordinates during this design.

## Live countdown behavior

The estimate is a genuine ticking countdown, not a value that only refreshes on the next 10-minute `lock-traffic.json` poll:

- Each approaching row's detail line becomes `${numBarges} barges · ETA ${countdown}`, replacing the "time ago" text (e.g. `11 barges · ETA 20m`).
- The rendered `<span>` carries the computed arrival timestamp in a `data-arrival` attribute (ISO string), so a lightweight tick doesn't need to re-fetch or re-render the whole row.
- A new `setInterval(tickEtaCountdowns, 30_000)` re-reads every `.eta-countdown` element's `data-arrival` and updates its text in place. 30 seconds keeps the display feeling live without meaningfully more DOM work than the existing 1-second AIS-reconnect countdown already in the app.
- No expiry: a lockage stays visible (and keeps counting up) for as long as it remains in the top-5 `recentLockages` list — same lifecycle as today, no new logic needed to hide old entries.

### Countdown text format

Given `remainingMs = arrivalMs - nowMs`, evaluated in this order:

1. `remainingMs >= 60_000` (still approaching, 1 minute or more of runway): `ETA ${hours}h ${mins}m` if `hours > 0` (omit `${mins}m` entirely when `mins === 0`), else `ETA ${mins}m` — where `hours = Math.floor(remainingMs / 3_600_000)` and `mins = Math.round((remainingMs % 3_600_000) / 60_000)`.
2. `-60_000 < remainingMs < 60_000` (within a minute either side of the estimate): `ETA arriving now`.
3. `remainingMs <= -60_000` (already passed): `Passed ~${hours}h ago` if `hours > 0`, else `Passed ~${mins}m ago` — where `hours`/`mins` are derived the same way as case 1, but from `Math.abs(remainingMs)` (this is already a rough estimate, so once it's past the 1-hour mark, minutes of precision on "how long ago" stop being meaningful and are dropped).

## Visual treatment

Plain text, same color/weight as the existing `.lockage-detail` styling — no red, no flashing, no alert banner. The real AIS danger-zone alert is a live detection; this ETA is a rough guess from stale data, and styling it the same way would misrepresent its reliability.

## Testing

The arrival-time math and the countdown/count-up text formatting are extracted into two small pure functions (`estimateArrival(lockageIso, distanceM, speedMps)` and `formatEtaCountdown(arrivalMs, nowMs)` — both take `now`/time explicitly rather than reading `Date.now()` internally, so they're testable without mocking the clock). These live inline in `index.html`'s `<script>` rather than `scripts/`, since they're UI-facing rendering logic, not data-pipeline logic. Consistent with how `cogToDirection()`/`etaMinutes()`/`distanceM()` are handled today, they are **not** unit-tested — this codebase has no test harness for `index.html`'s inline JS. Correctness is instead verified manually in a real browser: fake `lock-traffic.json` fixtures with lockage timestamps chosen to land in each of the format's cases (minutes, hours, arriving-now, just-passed, hours-passed), confirmed visually, including watching the 30-second tick actually update text without a page reload.

## Considered alternatives

- **Two direction-aware speeds** (slower upstream against current, faster downstream with it) — rejected. Adds a second magic constant for a distinction the user explicitly said doesn't need to be accurate.
- **River-following distance instead of straight-line** — rejected. No routing/polyline data exists in this app; the live AIS ETA already uses straight-line distance, so this stays consistent with existing precedent rather than introducing a more "accurate" distance calculation that the assumed-speed step would immediately wash out anyway.
- **Alert-style highlighting when a countdown nears zero** — rejected (see Visual treatment above): would blur the line between a real live AIS detection and a rough lockage-based guess.
- **Hiding the ETA once it flips to "passed"** — rejected per your countdown-then-count-up request; freezing at zero or disappearing both throw away information a rower might still find useful ("that barge probably passed 10 minutes ago").

## Out of scope

- Any change to `lock-traffic.json`'s shape, the fetch script, or the workflow.
- Persisting or historizing ETA estimates — this is purely a derived, ephemeral display value recomputed on every render/tick.
- Reconciling a lock-based ETA against a live AIS-tracked vessel for the same tow (e.g. via matching `mmsi`) — noted as a future idea in the original Lock Traffic spec's out-of-scope list, still not built here.
