# Lock-approach tracking & forecasting — design

## Goal

Extend the barge tracker to show vessels approaching OVRC Launch from further
upriver (Belleville Locks and Dam) and further downriver (Willow Island Locks
and Dam), with a forecasted ETA, well before they reach the existing 3-mile
danger zone. Applies to both the Node/SSE version (`server.js` +
`public/app.js` + `public/index.html`) and the static standalone version
(`standalone/index.html`), which stay independently self-contained as they
are today.

## Reference points

- **OVRC Launch**: `[39.2833, -81.5631]` (existing)
- **Belleville Locks and Dam**: `[39.1193, -81.7425]` — river mile 203.9,
  south of OVRC (downriver toward Cairo)
- **Willow Island Locks and Dam**: `[39.3592, -81.3192]` — river mile 161.7,
  north of OVRC (upriver toward Pittsburgh)

Locally, between these two locks the river runs roughly north–south, so a
vessel's latitude relative to OVRC's latitude is a reliable proxy for "which
side" it's on.

## AIS coverage

- Widen the existing AISStream `BOUNDING_BOX` from
  `[[39.24, -81.60], [39.35, -81.50]]` to
  `[[39.05, -81.80], [39.42, -81.25]]`, comfortably covering both locks.
- Same AISStream WebSocket connection, same API key, same message handling —
  no new streaming data source. AISStream has no REST/snapshot endpoint; it
  only pushes `PositionReport` messages as they're transmitted, so a
  freshly-opened connection is empty until reports arrive.

## Classification: Nearby vs. Approaching

Keep the existing 3-mile danger zone (`ZONE_CENTER`, `DANGER_RADIUS_M`)
unchanged. Add:

- `NEARBY_RADIUS_M` — matches the old bounding box's rough coverage
  (~8 miles / ~12,874 m) from `ZONE_CENTER`. Vessels inside this radius behave
  exactly as today (existing "Nearby vessels" sheet, existing alert banner
  logic untouched).
- Vessels outside `NEARBY_RADIUS_M` but inside the new wide bounding box are
  candidates for the new **Approaching** panel, classified as:
  - **From Belleville**: latitude < OVRC's latitude, and
    `cogToDirection(cog) === 'Upriver'` (closing in on OVRC).
  - **From Willow Island**: latitude > OVRC's latitude, and
    `cogToDirection(cog) === 'Downriver'` (closing in on OVRC).
  - Anything else out there (e.g., moving away from OVRC) still gets a map
    marker but is not listed in the panel — avoids clutter from outbound or
    unrelated traffic.
- ETA reuses the existing `etaMinutes(distanceM(ZONE_CENTER, vessel), sog)`
  math — same straight-line haversine calculation already used for the 3-mile
  zone. This is intentionally not modeling the river's actual bends; ETA is
  an estimate that gets more accurate as a vessel gets closer, same tradeoff
  as today.

## UI: Approaching panel

Both pages use a mobile bottom-sheet layout (`#sheet`), not a sidebar. Add a
second, collapsible horizontal-scroll strip above the existing "Nearby
vessels" strip:

- Header: "Approaching" with a count badge. Collapsed by default when count
  is 0; tapping expands/collapses.
- When expanded, two sub-groups, each sorted by ascending ETA, using the
  existing `chipHtml`/`.vessel-chip` styling:
  - "↑ From Belleville"
  - "↓ From Willow Island"
- No new alert banner or toast — the existing red 3-mile danger alert is
  unchanged and still only fires for vessels inside `DANGER_RADIUS_M`.

## No on-demand snapshot (AISStream only)

AISStream can't answer "who's out there right now" — only future pushes —
so on a fresh connection the Approaching panel populates gradually as
`PositionReport`s arrive, same cold-start behavior the app already has
today. A REST snapshot provider (VesselAPI or similar) was considered to
close that gap, but the user doesn't have an account with one and is fine
accepting the few-minutes cold start, so it's dropped from scope. Revisit if
that changes — the Approaching panel's `applyVessel` path would accept a
snapshot merge without further redesign.

## Out of scope

- No integration with USACE's Lock Performance Monitoring System or any
  official lock-transit/queue status — not available as a real-time API.
- No river-mile-based distance modeling for ETA — straight-line distance is
  accepted as good enough.
- No milestone alert/toast when a vessel first appears near a lock — the
  Approaching panel is the only new surface.
- No second AIS *streaming* provider for failover — evaluated and rejected;
  see conversation history. All commercial AIS ultimately draws from the
  same underlying receiver network, so it isn't meaningfully independent
  redundancy, and the actual pain point (waiting on cold start / wanting an
  on-demand check) is better solved by the VesselAPI snapshot above.

## Known pre-existing issue (not part of this change)

`standalone/index.html:117` hardcodes a live AISStream API key in plaintext.
If this page is served publicly (e.g. GitHub Pages), that key is exposed.
Not addressed by this design — flagged separately for the user to decide on
(rotate/gitignore) independently of this feature.
