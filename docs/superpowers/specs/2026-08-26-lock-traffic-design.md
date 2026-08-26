# Lock Traffic (USACE Lock Queue) — Second Traffic Signal

Design spec for adding an independent signal for barge traffic near OVRC Launch, separate from the AISStream.io live AIS feed. This is a permanent addition (kept even once AIS is confirmed reliable), not a stopgap — motivated by AIS currently showing zero vessel updates ([see `docs/superpowers/specs/2026-08-21-phase1-ais-relay-design.md`](2026-08-21-phase1-ais-relay-design.md) and `MAINTENANCE.md`'s "Known open issue" for that unresolved investigation). This also closes out the "Out of scope" note in `2026-08-21-river-conditions-design.md`: "Any lookup of Army Corps of Engineers lock & dam data (Belleville/Willow Island) ... could be a future phase."

Hard constraint: must run entirely on the existing static GitHub Pages + GitHub Actions architecture — no new server, no changes to the Cloudflare Worker.

## Problem

The AIS relay's connection health doesn't tell you whether vessels are actually moving past OVRC Launch — either because AIS itself may be broken/throttled, or because AIS coverage has known gaps (small craft, and per `README.md`'s "AIS coverage note," reliability varies). A second, independently-sourced signal gives real confidence even if AIS is down, and cross-checks it when AIS is up.

Belleville Locks and Dam and Willow Island Locks and Dam bracket the tracked stretch of river (both already have known coordinates in `index.html`, used today for AIS approach-direction classification — `BELLEVILLE = [39.1193, -81.7425]`, `WILLOW_ISLAND = [39.3592, -81.3192]`). A vessel locking through either one is a strong leading/trailing indicator of traffic near OVRC.

## Data source

US Army Corps of Engineers **Lock Performance Monitoring System (LPMS)**, "Lock Queue Report" JSON web service — confirmed live and public during this design's research (fetched directly, real data returned; `ndc.ops.usace.army.mil` has no `robots.txt` restriction).

```
https://ndc.ops.usace.army.mil/ords/lpms/json/lock_queue_json?in_river={river}&in_lock={lock}
```

- `river` = 2-character river code. Ohio River = `OH`.
- `lock` = 2-character lock number. **Belleville = `21`. Willow Island = `72`.** (Looked up via the site's own "River and Lock Codes" table, `https://ndc.ops.usace.army.mil/ords/r/lpms/corps-locks/data-web-services`.)

Despite the page's "Lock Queue Report" label, this returns actual **completed lockages from the past 30 days**, newest first — not a live "currently waiting" queue. Each entry:

```json
{
  "vesselName": "GLENN A HENDON",
  "vesselNo": "0625977",
  "direction": "U",
  "numBarges": 11,
  "SOLdate": "08/11/26 20:09",
  "arrivalDate": "08/11/26 19:20",
  "endOfLockage": "08/11/26 20:48",
  "timezone": "EST",
  "MMSI": 367375080
}
```

`direction` is `U` (upbound) or `D` (downbound). This is exactly the recent-activity log needed — no auth, no API key, plain public GET.

**`timezone` is always literally `"EST"`, even for August timestamps** — confirmed against real data pulled during this design (both locks). USACE is not doing DST-aware labeling here; treat `timezone` as a fixed **UTC-5** offset when converting to ISO-8601, not as a real IANA zone name to look up.

## `lock-traffic.json` shape

Published at the repo root, alongside `river.json`:

```json
{
  "updated": "2026-08-26T18:05:00.000Z",
  "locks": {
    "belleville": {
      "name": "Belleville Locks and Dam",
      "recentLockages": [
        {
          "vesselName": "GLENN A HENDON",
          "direction": "U",
          "numBarges": 11,
          "endOfLockage": "2026-08-11T20:48:00-05:00",
          "mmsi": 367375080
        }
      ]
    },
    "willowIsland": {
      "name": "Willow Island Locks and Dam",
      "recentLockages": []
    }
  }
}
```

- `recentLockages` keeps the **5 most recent** entries per lock, as returned (newest first) — no time-window filter. If the most recent entry is days old, that itself is honest signal ("nothing has passed recently"), not something to hide.
- `endOfLockage` is normalized from USACE's `MM/DD/YY HH:mm` + `timezone` into ISO-8601, so the frontend can use one date-parsing path for this and for `river.json`'s `updated` field.
- `vesselNo` and `arrivalDate`/`SOLdate` are dropped — not used by the UI; `endOfLockage` (when the vessel cleared the lock) is the timestamp that matters for "how recently did a vessel pass."

## Components

1. **`scripts/lib/fetch-with-retry.mjs`** (new, extracted) — the timeout+retry logic currently inlined in `update-river-conditions.mjs` (`fetchJson`, `withRetry`, `FETCH_TIMEOUT_MS`/`RETRIES`/`RETRY_DELAY_MS`), generalized slightly to accept a URL and return parsed JSON, used by both `update-river-conditions.mjs` and the new `update-lock-traffic.mjs`. `update-river-conditions.mjs` is updated to import from here instead of defining its own copy.
2. **`scripts/shape-lock-traffic.mjs`** (new, pure, unit-tested) — `shapeLockQueue(rawArray)` → `{ recentLockages: [...top 5, normalized] }`. No network, no filesystem — same pattern as `compute-trend.mjs`.
3. **`scripts/shape-lock-traffic.test.mjs`** (new) — `node --test` cases: normalizes date format, caps at 5, handles an empty array (no lockages in the past 30 days), passes through `direction`/`numBarges`/`vesselName`/`mmsi` unchanged.
4. **`scripts/update-lock-traffic.mjs`** (new, orchestrator, mirrors `update-river-conditions.mjs`) — fetches Belleville and Willow Island in parallel via `fetch-with-retry`, shapes each with `shapeLockQueue`, writes `lock-traffic.json`. On failure, reuses the same "don't fail the job if existing data is under 12h stale" fallback as `update-river-conditions.mjs` (`STALE_THRESHOLD_MS`), reading `lock-traffic.json`'s own `updated` field.
5. **`.github/workflows/lock-traffic.yml`** (new, standalone workflow — not merged into `river-conditions.yml`) — kept separate so a failure in one job can never block the other's commit (each `run:` step failing stops the rest of that job). Cron: `'5,35 * * * *'` (offset from `river-conditions.yml`'s `'*/30 * * * *'`) so the two workflows' `git push` calls don't race against each other on `main`. `workflow_dispatch` for manual runs. Same commit pattern as `river-conditions.yml` (`github-actions[bot]`, commit+push only if `lock-traffic.json` changed).
6. **`index.html`**: the page is split into two full-screen tabs, replacing today's single always-visible layout (validated with the user via mockups before writing this):
   - **"Map & Vessels"** — the existing experience, unchanged: map, danger zone, approaching groups, nearby-vessels bottom sheet.
   - **"Traffic Log"** — new, full-screen when active (map is not rendered underneath while this tab is open, matching the approved mockup). Contains the existing **River Conditions** panel (moved here from its current placement) plus the new **Lock Traffic** panel: for each lock, name, most recent lockages' direction/barge-count/relative time ("2h ago" style, matching the existing `river-updated` time formatting), and an "Updated" timestamp (from `lock-traffic.json`'s `updated`). Fetches `./lock-traffic.json` the same way `updateRiverConditions()` fetches `./river.json` (cache-busted, same try/catch → "data unavailable" fallback pattern).
   - A tab bar sits below the top bar; the AIS connection pill in the top bar stays visible regardless of active tab, since it's a live-status indicator, not tab content.
   - Switching tabs is a pure client-side view toggle (no navigation/reload) — both tabs' data keeps polling in the background regardless of which is active, so switching to "Traffic Log" never shows stale data while a fetch was pending.

## Considered alternatives

- **B — client-side fetch direct from the browser, no GitHub Actions step.** Rejected: USACE's ORDS endpoints aren't confirmed to set CORS headers for arbitrary browser origins, and unlike AIS this data doesn't need push/live-socket freshness — polling on the existing 30-minute cadence is more than adequate for "did something pass in the last few hours." If a future need for sub-30-minute freshness arises, proxy through the existing Cloudflare Worker rather than relying on USACE CORS.
- **C — also persist a rolling history file, to seed a future "typical traffic by hour/day" baseline.** Deferred, not built now. `lock-traffic.json` only ever holds the latest snapshot (top 5 per lock), same as `river.json` holds only the latest reading. A future phase could append each run's data to a separate `lock-traffic-history.json` (with a retention cap, e.g. last 90 days) — worth doing once the live signal itself has been running long enough to be trusted, not before.
- **Other AIS providers (MarineTraffic, VesselFinder)** — ruled out during brainstorming: real APIs exist but have no usable free tier ($100+/month), and this is a no-cost personal project.
- **Scraping `marinevesseltraffic.com`** — ruled out: that site's `robots.txt` explicitly disallows `anthropic-ai`/`Claude-Web`/`Claudebot`, an explicit statement that AI agents shouldn't access it.
- **UI: map-always-visible tabs** (only the bottom sheet tabs, map stays on screen and shrinks) — considered via mockup alongside the chosen full-screen-tabs approach, rejected in favor of giving "Traffic Log" the full screen since river conditions + both locks need more room than a shrunk bottom sheet allows.

## Out of scope

- Sub-30-minute freshness for lock data (see Approach B above).
- Historical/statistical baseline modeling (see Approach C above).
- Any change to the AIS relay (`worker/`) or its unresolved "zero vessel updates" investigation — this is a fully independent signal, not a fix for that issue.
- Vessel-type/geographic filtering, or correlating a specific lock lockage record to a specific AIS-tracked vessel (e.g. by matching `MMSI`) — the data model here includes `mmsi` for a possible future cross-reference, but no matching logic is built in this phase.
