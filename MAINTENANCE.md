# Maintenance Guide

Operational reference for the two automated systems behind `index.html` (served via GitHub Pages at `https://jahart.github.io/barge-tracker/`): the Cloudflare Worker AIS relay and the GitHub Actions river-conditions workflow. See `docs/new_release_phases.md` for the broader feature roadmap and `docs/superpowers/specs/` / `docs/superpowers/plans/` for the design/implementation history of what's built so far.

## How publishing works

This repo (`git@github.com:jahart/barge-tracker.git`, branch `main`) is the source of truth for GitHub Pages. Push to `main` and the live site updates within about a minute (GitHub's CDN cache is `max-age=600`, but pushes typically invalidate it quickly — if a change doesn't appear, hard-refresh or wait a minute before assuming something's wrong).

There is no build step — `index.html` at the repo root is served as-is.

## Cloudflare Worker (AIS relay)

**What it does:** Holds the AISStream.io API key as a server-side secret and relays live vessel position data to the browser over a plain WebSocket connection, so the key is never exposed client-side. Lives in `worker/`.

It's a plain Worker — no Durable Object, no persisted/shared state. Each browser connection to `/events` gets its own dedicated upstream AISStream WebSocket for as long as that browser stays connected; the Worker reshapes AIS messages and forwards them straight through. This replaced an earlier Durable-Object-based design (one shared upstream connection broadcasting SSE to all browsers) that hit the Durable Objects wall-clock "duration" billing quota — a plain Worker only bills CPU time, so holding a per-browser socket open costs nothing while idle. See git history (`fix: drop the Durable Object, proxy AISStream over a plain Worker WebSocket`) for that change.

**Files:**
- `worker/src/index.js` — the entire relay: routes `GET /events` (WebSocket upgrade only, else 404/426), opens one upstream AISStream connection per browser connection, parses and forwards `PositionReport` messages, reconnects with backoff if the upstream drops, and closes the upstream when the browser disconnects.
- `worker/src/lib/backoff.js` — reconnect delay (starts at `INITIAL_DELAY_MS`, doubles via `nextDelay()`, caps at `MAX_DELAY_MS`).
- `worker/src/lib/vessels.js` — `parsePositionReport()` turns a raw AIS message into a vessel object. Also exports `findStale()`, which is still unit-tested but has **no caller** — it was for the old Durable Object's in-memory vessel map/sweep; this Worker keeps no server-side vessel state, so staleness is entirely a client-side concern now.
- `worker/wrangler.toml` — Worker config. Deployed as `barge-tracker-relay`, live at `https://barge-tracker-relay.jerry-ahart.workers.dev`. Its `[[migrations]]` entries record creating and then deleting the old `AisRelay` Durable Object class.

**Deploying a change:**
```bash
cd worker
npm run deploy   # or: npx wrangler deploy
```

**Rotating the AISStream API key** (do this if it's ever exposed again, e.g. pasted somewhere public):
1. Get a new key at https://aisstream.io (and revoke the old one there).
2. Set it as the secret, trimmed (no trailing newline):
   ```bash
   cd worker
   printf '%s' "$(cut -d= -f2- .dev.vars)" | npx wrangler secret put AISSTREAM_API_KEY
   ```
3. No redeploy or ID-rotation dance needed here (that was only required by the old Durable Object, which captured the key once at construction and never re-read it). This Worker reads `env.AISSTREAM_API_KEY` fresh on every new browser connection, so an updated secret takes effect on the next connection automatically.
4. After rotating, **don't immediately hammer the endpoint with repeated test connections** — see the throttling note below.

**Local development:**
1. `cd worker && npm install` (first time only).
2. Create `worker/.dev.vars` (gitignored, never committed) with `AISSTREAM_API_KEY=your_key_here`.
3. `npm run dev` (or `npx wrangler dev`) — runs a local copy on `http://localhost:8787`.
4. Point a local test copy of `index.html`'s `RELAY_URL` at `ws://localhost:8787/events` to test end-to-end.
5. There's no CORS handling in `index.js`, and none is needed — WebSocket upgrades aren't subject to browser CORS the way `fetch`/SSE requests are. (The old Durable-Object version hardcoded `Access-Control-Allow-Origin` for its SSE endpoint; that went away with the DO.)

**Tests:** `cd worker && npm test` (or `npx vitest run`) — `test/backoff.test.js` and `test/vessels.test.js` cover pure logic; `test/index.test.js` covers routing (404 for unknown paths, 426 for non-upgrade requests to `/events`). The actual relay behavior in `relayToClient()` isn't unit-tested — it depends on Workers-runtime WebSocket behavior that doesn't mock cleanly, so verify manually via `wrangler dev` plus a real WebSocket client after any change to it (`curl` can't do a real WebSocket handshake — see below).

**Watching live logs:** `cd worker && npx wrangler tail` — streams real-time logs from the deployed Worker. All relay logic now runs directly in the top-level `fetch` handler (no Durable Object indirection), so `console.log`/`console.error` calls in `index.js` show up reliably here.

**Known open issue: no vessel traffic observed yet — needs re-verification under this architecture.** The last investigation (done under the old Durable-Object design) found AISStream connections closing abruptly (WebSocket code `1006`, no reason) roughly 700ms after the subscribe message, across three separate client implementations, with zero AIS messages received even against a global bounding box. Leading theory was AISStream-side throttling triggered by many rapid connection attempts made while debugging, not a real bug — see git history for the full writeup if useful.

This has **not been re-checked since the Durable Object was dropped** for the current per-browser-connection design, and the old verification method (treating `/events` as an SSE endpoint via `curl -N`) no longer applies — `/events` is WebSocket-only now, so plain `curl` just gets a 426. To verify:
1. Use a real WebSocket client (e.g. `wscat`, `websocat`, or a browser tab) to connect to `wss://barge-tracker-relay.jerry-ahart.workers.dev/events`.
2. Watch for an `{"type":"ais-connected"}` message followed by `{"type":"update",...}` messages with real vessel data.
3. If you see zero `update` messages, don't retry rapidly — wait at least 15–20 minutes before checking again, to avoid re-triggering the suspected throttling.

## River conditions (`river.json`)

**What it does:** A GitHub Actions workflow fetches real river data every 30 minutes and commits `river.json` to the repo root, which `index.html` polls. There is no server involved — it's a scheduled static-file generator.

**Files:**
- `.github/workflows/river-conditions.yml` — the schedule (`*/30 * * * *` cron + manual `workflow_dispatch`).
- `scripts/update-river-conditions.mjs` — fetches USGS (stage) and NWS (flood category), writes `river.json`.
- `scripts/compute-trend.mjs` (+ `compute-trend.test.mjs`) — pure trend classification logic (rising/falling/steady), unit-tested.

**Data sources** (both public, no auth required):
- USGS stage: `https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json` (Ohio River at Parkersburg, gauge 03151000).
- NWS flood category: `https://api.water.noaa.gov/nwps/v1/gauges/parw2`.

**Important limitation:** only **stage** (river level, ft) is real data for this exact gauge. Neither USGS nor NWS publishes discharge/flow or velocity for this location — confirmed by checking both APIs directly (USGS discharge was discontinued here in 1969; NWS's own flow field returns `-999`, its explicit "not available" sentinel). Don't reintroduce a fabricated current-speed number without first confirming a real source exists — see `docs/superpowers/specs/2026-08-21-river-conditions-design.md` for the research that established this.

**Manually triggering a run:** GitHub → Actions tab → "Update river conditions" → "Run workflow". Useful for testing without waiting up to 30 minutes.

**Troubleshooting a failed run:** check the Actions tab — the script fails loudly (non-zero exit) if either API call fails or returns unexpected data, rather than silently committing bad data. Common causes: USGS or NWS API temporarily down, or the gauge/site IDs changing (unlikely, but government APIs occasionally restructure).

**Testing locally:**
```bash
node scripts/update-river-conditions.mjs   # writes river.json to repo root
cat river.json                              # inspect it
rm river.json                               # don't commit a locally-generated copy — only the workflow should
node --test scripts/compute-trend.test.mjs  # pure-logic tests
```

## Known pending work

- **Retiring `server.js` / `public/app.js` / `public/index.html`**: these are the old local-Express-server version of the tracker, superseded by the Cloudflare Worker relay. On hold pending a longer live-stability check of the Worker. Root `package.json` still lists `express`/`ws`/`dotenv` for this reason.
- **A real (rotated, now-harmless) AISStream key exists in this repo's pre-`main`-force-push git history.** Not urgent since it's revoked, but worth rewriting history to purge it before treating this repo's full history as safe to share widely.
- **`docs/new_release_phases.md` Phases 4–8** (rowing-conditions indicator, AIS vessel-type/geographic filtering, river-geometry-aware direction, Neal Island map layer, historical trend charts) are not yet started.
