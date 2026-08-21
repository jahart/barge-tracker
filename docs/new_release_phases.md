# New Release Phases

Proposed roadmap for evolving the standalone barge tracker beyond AIS-only tracking. Captured from a planning discussion on 2026-08-21.

## Recommendation summary

Agree with the overall shape, with two caveats:

1. **Phase 1 is real and urgent, not hypothetical.** The AISStream API key is currently hardcoded client-side in `standalone/index.html` (`AISSTREAM_API_KEY` constant, ~line 368) and shipped in a public GitHub Pages repo. This should be treated as its own standalone task, done and verified before any other phase starts.
2. **"A Cloudflare Worker" undersells the Phase 1/5 architecture.** A plain Worker is stateless per-request — it can't hold open a persistent AISStream WebSocket and broadcast to browsers on its own. That requires a **Durable Object** (or equivalent) to own the long-lived connection. Confirm this is in scope and check free-tier Durable Object usage limits before committing to the design.

Everything else — river gauge data, refusing to publish a fabricated "current mph" number without a defensible derivation, rowing-conditions indicator, geometry-aware upstream/downstream instead of compass buckets — is reasonable and worth doing, but it's seven phases of feature work stacked behind one security fix. Scope and ship Phase 1 alone first; only commit to later phases once it's deployed and the existing map is confirmed to behave exactly as before.

## Phase 1 — Fix the AIS architecture (do first, standalone)

Move the AISStream connection off the browser and behind a Cloudflare Worker + Durable Object, so the API key is a server-side secret instead of embedded in `index.html`.

```
AISStream WebSocket --(secret API key)--> Cloudflare Worker/Durable Object <--(WebSocket)--> GitHub Pages (browser)
```

- GitHub repo stays public; the key never appears in it.
- Rotate the currently-exposed key as step zero, regardless of when the rest of this phase ships.
- Verify the existing barge map behaves identically before moving on.

## Phase 2 — Add river conditions

Add USGS Ohio River gauge data (Parkersburg, WV — station 03151000) as a second data source alongside AIS, served through the same Worker.

- Discharge (cu ft/s) is not the same as velocity (mph) — do not compute or display a "current mph" figure unless there's a defensible derivation from a station that reports velocity or from discharge/cross-sectional data. A wrong number is worse than no number.

## Phase 3 — River Conditions panel

Surface stage, discharge, trend, and last-updated time in a small panel near the top of the existing UI.

## Phase 4 — Rowing conditions indicator

Use observed upriver/downriver time deltas (e.g., ~2.6 mph upriver vs. ~6+ mph downriver from a real outing) as a qualitative "strong current" signal, clearly labeled as an estimate that includes rowing effort/wind/turns, not a pure current measurement. Optional historical intraday graph once there's data to back it.

## Phase 5 — Improve the AIS data

Move the AISStream connection fully into the Worker/Durable Object so all browsers share one upstream connection instead of each opening their own. Use that central point to filter to the Parkersburg–Belleville–Neal Island–Willow Island stretch and, if AIS data supports it, to vessel types (towboats/barges/commercial) rather than every AIS-equipped vessel.

## Phase 6 — River-geometry-aware direction

Replace the current compass-bucket approximation (315°–45° = upriver, 135°–225° = downriver) with a river centerline model, so "From Belleville" / "From Willow Island" labeling and arrival-time estimates hold up on a river that doesn't run true north–south here.

## Phase 7 — Neal Island / rowing zone map layer

Add landmarks to the map: OVRC launch, Memorial Bridge, Neal Island, Belleville Lock & Dam, Willow Island Lock & Dam, the 3-mile danger zone, and the river centerline — to make the map directly useful for a launch/no-launch decision.

## Phase 8 — Historical conditions

Periodically log timestamp/stage/discharge/estimated current and show 24-hour trend (e.g., stage change, estimated current change, improving/worsening indicator). Start with the simplest possible storage — no need for a full database initially.

## Suggested execution order

1. Rotate the exposed AISStream key immediately.
2. Stand up the Cloudflare account/Worker + Durable Object.
3. Get a minimal Worker/Durable Object talking to AISStream.
4. Point `index.html` at the Worker instead of AISStream directly.
5. Verify the existing barge map is unchanged. **Ship and confirm here before continuing.**
6. Add the USGS Parkersburg gauge.
7. Surface river stage/trend in the UI.
8. Work out a defensible current-speed (mph) derivation, if possible.
9. Add Neal Island / river geometry and improve upstream/downstream logic.
10. Add historical/current-condition visualization.

Guiding principle: don't break the working barge tracker while adding river intelligence.
