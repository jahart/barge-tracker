# River Conditions Data Source

Design spec for finishing the river-conditions feature already partially built into `index.html` (stashed/merged from earlier work) — Phase 2/3 of `docs/new_release_phases.md`. `index.html` currently fetches `./river.json`, which doesn't exist, so the panel always shows "River data unavailable."

## Problem

The existing UI code expects `{ usgs: { stageFt }, nws: { flowKcfs, velocityMph } }`, generated (per an existing code comment) by GitHub Actions. Real research into the actual data sources for this exact gauge shows that expectation doesn't match reality:

- **USGS** (station 03151000, Ohio River at Parkersburg) currently reports only **stage** (gage height, parameter `00065`) and precipitation in real time. Discharge (`00060`) was last recorded here in 1969 — it's a discontinued parameter at this site, not currently available.
- **NWS's own API** (`api.water.noaa.gov/nwps/v1/gauges/parw2`) independently confirms this: its `observed.secondary` (flow, in `kcfs`) is `-999` — NWS's explicit "not available" sentinel for this specific gauge.
- **Velocity** isn't a product either agency publishes for this location at all — not missing-but-derivable, just nonexistent as a data source here.

So only **stage** is real, live data for this exact spot. Everything else the current UI expects (flow, velocity, and the velocity-driven current-condition banner) has no honest data source and must be dropped rather than faked.

One genuine, official, and directly useful data point was found during research that the current UI doesn't use: NWS's **flood category** classification (`no_flooding`/`minor`/`moderate`/`major`), computed by NWS against official stage thresholds for this gauge (minor 36 ft, moderate 38 ft, major 42 ft). This is real safety context, not fabricated, and is included in this design.

## Data sources

1. **Stage + trend** — `https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json`
   Returns roughly 10 timestamped stage readings over a 3-hour trailing window (USGS updates this gauge ~every 15 min). No auth required.
   - `stageFt` = the newest reading's value.
   - `trend` = compare newest reading to the oldest reading in the window: `"rising"` if the newest is more than 0.05 ft higher, `"falling"` if more than 0.05 ft lower, otherwise `"steady"` (the 0.05 ft band absorbs sensor noise so the arrow doesn't flap on essentially-flat water).

2. **Flood category** — `https://api.water.noaa.gov/nwps/v1/gauges/parw2`
   Returns `status.observed.floodCategory`, one of `no_flooding` / `minor` / `moderate` / `major`. No auth required.

Both are plain public GETs — no API keys, no CORS issues expected (both are public government data APIs intended for external consumption), and both are called fresh on every workflow run (no state carried between runs).

## `river.json` shape

Published at the repo root (`/river.json`), matching `index.html`'s existing `RIVER_DATA_URL = './river.json'`:

```json
{
  "stageFt": 24.67,
  "trend": "falling",
  "floodCategory": "no_flooding",
  "updated": "2026-08-21T18:00:00Z"
}
```

`trend` is one of `"rising"` / `"falling"` / `"steady"`. `floodCategory` is one of `"no_flooding"` / `"minor"` / `"moderate"` / `"major"` (passed through verbatim from NWS). `updated` is an ISO-8601 timestamp set by the workflow at generation time.

## GitHub Actions workflow

- **Trigger**: `schedule` cron every 30 minutes, plus `workflow_dispatch` for manual runs.
- **Runs on**: `ubuntu-latest`, no extra dependencies beyond `curl`/`jq` or a small Node script (implementation plan decides which).
- **Steps**: fetch both APIs, build `river.json`, commit and push directly to `main` as `github-actions[bot]` (requires `permissions: contents: write` on the workflow).
- **Always commits**, even when the values are unchanged from the last run — only the `updated` timestamp necessarily changes every run, and committing every time keeps the "last updated" display trustworthy (an unchanged commit would make the freshness indicator look broken during genuinely calm/stable river conditions, which is common and not an error state).
- **Failure handling**: if either API call fails or returns unparseable data, the workflow should fail loudly (non-zero exit, visible in the Actions tab) rather than commit a partial/corrupt `river.json` or silently skip the run. The existing client-side error handling (`river.json HTTP 404`-style catch block) already covers the case where a run failed and `river.json` is stale or briefly missing.

## UI changes to `index.html`

- **Remove** the "Flow" and "Current" stat boxes from the river-conditions panel (`river-flow`, `river-velocity` elements and their containers) — nothing honest to show there.
- **Keep** the "Stage" stat box, adding a trend arrow (↑ rising / ↓ falling / → steady) next to the value.
- **Repurpose** the existing condition banner (colored dot + text — currently `river-condition`/`river-condition-dot`/`river-condition-text`, driven by fake velocity thresholds in `setRiverCondition(mph)`) to show the flood category instead, reusing the exact same visual escalation pattern (green → amber → orange → red) that's already built:
  - `no_flooding` → green, "NORMAL POOL"
  - `minor` → amber, "MINOR FLOODING"
  - `moderate` → orange, "MODERATE FLOODING"
  - `major` → red, "MAJOR FLOODING"
  - `setRiverCondition(mph)` is renamed/rewritten as `setFloodCategory(category)` with this mapping.
- **Delete** the now-dead velocity-threshold constants/logic and the `flowKcfs`/`velocityMph` handling inside `updateRiverConditions()`.
- **Error handling** stays as-is structurally (still catches fetch/parse failure and shows "River data unavailable" / "Fetch failed"), just no longer references flow/velocity fields that no longer exist.

## Out of scope

- Any attempt to derive or estimate current velocity (mph) for this stretch of river — no defensible data source was found; this is explicitly not being faked.
- Any lookup of Army Corps of Engineers lock & dam data (Belleville/Willow Island) for a possible discharge source — not researched as part of this design; could be a future phase if real velocity data is ever wanted.
- Any change to the Cloudflare Worker (`worker/`) — river data is fully static/GitHub-Actions-driven, unrelated to the AIS relay.
