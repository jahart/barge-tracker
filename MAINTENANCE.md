# Maintenance Guide

Operational reference for the two automated systems behind `index.html` (served via GitHub Pages at `https://jahart.github.io/barge-tracker/`): the Cloudflare Worker AIS relay and the GitHub Actions river-conditions workflow. See `docs/new_release_phases.md` for the broader feature roadmap and `docs/superpowers/specs/` / `docs/superpowers/plans/` for the design/implementation history of what's built so far.

## How publishing works

This repo (`git@github.com:jahart/barge-tracker.git`, branch `main`) is the source of truth for GitHub Pages. Push to `main` and the live site updates within about a minute (GitHub's CDN cache is `max-age=600`, but pushes typically invalidate it quickly — if a change doesn't appear, hard-refresh or wait a minute before assuming something's wrong).

There is no build step — `index.html` at the repo root is served as-is.

## Cloudflare Worker (AIS relay)

**What it does:** Holds the AISStream.io API key as a server-side secret and relays live vessel position data to the browser over Server-Sent Events, so the key is never exposed client-side. Lives in `worker/`.

**Files:**
- `worker/src/index.js` — Worker entry point, routes `GET /events` to the Durable Object.
- `worker/src/AisRelay.js` — the Durable Object: owns the persistent AISStream WebSocket, keeps an in-memory vessel map, broadcasts SSE to connected browsers, sweeps stale vessels every 60s via a Durable Object alarm.
- `worker/src/lib/backoff.js`, `worker/src/lib/vessels.js` — pure, unit-tested helper logic (reconnect delay, AIS message parsing, staleness).
- `worker/wrangler.toml` — Worker + Durable Object config. Deployed as `barge-tracker-relay`, live at `https://barge-tracker-relay.jerry-ahart.workers.dev`.

**Deploying a change:**
```bash
cd worker
npx wrangler deploy
```

**Rotating the AISStream API key** (do this if it's ever exposed again, e.g. pasted somewhere public):
1. Get a new key at https://aisstream.io (and revoke the old one there).
2. Set it as the secret, trimmed (no trailing newline — see gotcha below):
   ```bash
   cd worker
   printf '%s' "$(cut -d= -f2- .dev.vars)" | npx wrangler secret put AISSTREAM_API_KEY
   ```
3. **Important gotcha:** updating the secret is *not enough by itself*. The already-running Durable Object instance captured the old key in memory at construction time and keeps using it — it does not re-read the secret. You must also force a fresh instance by changing the `idFromName(...)` argument in `worker/src/index.js` (e.g. `'ohio-river-v2'` → `'ohio-river-v3'`), then `npx wrangler deploy`. Add a comment explaining the rename (see the existing one in that file) so a future rotation doesn't lose this context.
4. After rotating, **don't immediately hammer the endpoint with repeated test connections.** AISStream documents throttling "at the api key and user level" for accounts with many concurrent/rapid connections — several quick test connections against a brand-new key (from prior debugging) produced a WebSocket close code `1006` (abnormal closure, no reason given) on every single attempt, across three different WebSocket client implementations (Cloudflare Workers, plain Node, the `ws` npm package) — strongly suggesting the rapid testing itself triggered throttling rather than there being a real bug. After rotating, deploy once, then wait at least 15–20 minutes before checking `/events` again.

**Local development:**
1. `cd worker && npm install` (first time only).
2. Create `worker/.dev.vars` (gitignored, never committed) with `AISSTREAM_API_KEY=your_key_here`.
3. `npx wrangler dev` — runs a local copy on `http://localhost:8787`.
4. Point a local test copy of `index.html`'s `RELAY_EVENTS_URL` at `http://localhost:8787/events` to test end-to-end. Note: the Worker's CORS is locked to `https://jahart.github.io` (see below), so a plain browser fetch from `localhost` will be blocked — either temporarily add your local origin to `AisRelay.js`'s `CORS_ORIGIN`, or just verify with `curl` (CORS is a browser-enforced restriction, not a server one).

**Tests:** `cd worker && npx vitest run` — covers `backoff.js` and `vessels.js` (pure logic only). `AisRelay.js` itself isn't unit-tested — it depends on Workers-runtime-only globals (`WebSocket`, `DurableObjectState`, `TransformStream`) that don't mock cleanly outside the real runtime, so it's verified manually via `wrangler dev` + `curl` after any change to it.

**Watching live logs:** `cd worker && npx wrangler tail` — streams real-time logs from the deployed Worker (useful for confirming AIS messages are actually arriving, or diagnosing errors).

**CORS:** `AisRelay.js` hardcodes `Access-Control-Allow-Origin: https://jahart.github.io`. If the site is ever served from a different domain, update the `CORS_ORIGIN` constant in `worker/src/AisRelay.js` and redeploy.

**Known open issue: no vessel traffic observed yet.** As of this writing, `snapshot.vessels` has stayed empty in every check, even though the Worker successfully connects to AISStream (`ais-connected` fires). This has NOT yet been confirmed as either "genuinely no traffic" or "a real bug" — the investigation is incomplete. Read this before spending more time on it, to avoid repeating dead ends:

- **`wrangler tail` is unreliable for this.** Confirmed by testing: a `console.log` in the top-level Worker (`index.js`) shows up in `wrangler tail --format json`; an equivalent `console.log` inside the Durable Object (`AisRelay.js`, invoked via `stub.fetch()`) does not, even though the request itself is traced. Don't trust "I don't see logs" as evidence of anything — if you need visibility into what's happening inside the DO, expose it via the HTTP response instead (e.g., a temporary counter field in the `snapshot` payload), the way this investigation eventually did.
- **A real, reproducible failure was found and is not yet fully explained:** using a temporary global bounding box (`[[-90,-180],[90,180]]`) and a diagnostic message counter (bypassing the tail-logging gap above), zero AIS messages arrived over 30+ seconds — which should be an obvious firehose if the subscription were working normally. The WebSocket connection itself gets abruptly closed (code `1006`, no reason, `wasClean: false`) roughly 700ms after the subscribe message is sent. This was reproduced identically across three separate WebSocket client implementations (Cloudflare Workers, a plain Node script, the `ws` npm package), which rules out our code/library as the cause.
- **Leading theory, not yet confirmed:** AISStream's own docs mention throttling "at the api key and user level" for many connections on one key. The 1006 pattern first appeared after this investigation had already made many rapid connection attempts while debugging (several diagnostic Durable Object instances, each holding its own persistent connection on the same key, plus multiple manual test scripts run back-to-back). The key was rotated once already during this investigation and the failure persisted — but that rotation was immediately followed by more rapid testing, which may have re-triggered the same throttling before it could be ruled out cleanly.
- **AISStream's docs say an invalid key produces an explicit `{"error": "Api Key Is Not Valid"}` message**, not a silent connection drop — so the 1006 pattern doesn't look like "the key is wrong," it looks more like a network/throttling-level rejection.

**How to verify from a fresh session, without repeating the mistake above:**
1. Check `worker/src/index.js` for the current `idFromName(...)` value and `worker/src/AisRelay.js` for the current `BOUNDING_BOX` — confirm both are the real production values (a narrow real bounding box, not a diagnostic global one; a plain descriptive ID, not one with "diag" in the name). If either looks like leftover diagnostic scaffolding, that's a sign a previous session didn't clean up — revert to real values and redeploy once.
2. Make exactly **one** request: `curl -N --max-time 15 https://barge-tracker-relay.jerry-ahart.workers.dev/events` and read the full output.
3. If you see `ais-connected` and, over that window, at least one `update` event with real vessel data — it's fixed, no further action needed.
4. If you see zero `update` events, **wait at least 15–20 minutes without making any further requests**, then make exactly one more check the same way. Resist the urge to retry rapidly — that's the exact pattern suspected of causing the 1006 closures in the first place.
5. If it's still empty after that patient check, the next real diagnostic step (not yet done — the diagnostic code from this investigation was reverted rather than committed, so it doesn't exist in git history): temporarily add a counter to `AisRelay.js` — e.g. `this.diagnosticRawMessageCount = 0` in the constructor, `this.diagnosticRawMessageCount++` at the top of `handleAisMessage()` (before the `parsePositionReport` filter, so it counts *any* message, not just position reports), and include it in the `snapshot` object in `fetch()`. This surfaces whether AISStream is sending anything at all, sidestepping the `wrangler tail` gap described above. Redeploy under a fresh `idFromName` (to guarantee a clean instance), make **one** check, then immediately revert both the counter and the ID change and redeploy the clean version regardless of outcome — don't leave diagnostic code or IDs deployed.

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
