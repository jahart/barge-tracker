# Phase 1: AIS Relay via Cloudflare Worker + Durable Object

Design spec for Phase 1 of `docs/new_release_phases.md` — moving the AISStream connection off the browser so the API key is never shipped client-side.

## Problem

`standalone/index.html` (served via GitHub Pages at `https://jahart.github.io/barge-tracker`) currently hardcodes `AISSTREAM_API_KEY` and opens a direct `wss://stream.aisstream.io/v0/stream` connection from the browser. The key is exposed to anyone who views source on the public page.

Separately, `server.js` (local Express server) already solves this correctly for local/ngrok use: it holds the AISStream WebSocket server-side (key in `.env`), maintains an in-memory vessel map, and broadcasts updates to browsers over Server-Sent Events (`/events`), consumed by `public/app.js`.

## Decision

Replace both the exposed browser-side connection *and* the local Express server with a single Cloudflare Worker + Durable Object relay. One relay serves both local development (via `wrangler dev`) and the public GitHub Pages page. `server.js`, `public/app.js`, `public/index.html`, and the ngrok instructions in `README.md` are deleted once the Worker is verified.

The Worker/Durable Object logic is a near-direct port of `server.js`'s existing, working logic — same bounding box, same reconnect/backoff, same message shapes — not a redesign.

## Architecture

```
AISStream WebSocket
        │ (secret, via `wrangler secret put`)
        ▼
┌─────────────────────────────┐
│ Durable Object: AisRelay    │
│  - owns the AISStream WS    │
│  - in-memory vessel Map     │
│  - in-memory SSE client Set │
│  - reconnect/backoff        │
│  - stale-vessel alarm()     │
└──────────────┬──────────────┘
               │ SSE (GET /events)
               │ CORS: Access-Control-Allow-Origin: https://jahart.github.io
               ▼
   ┌───────────────────────┐
   │ standalone/index.html │
   │ (GitHub Pages)        │
   └───────────────────────┘
```

One Worker, one fixed-name Durable Object instance (`env.AIS_RELAY.idFromName("ohio-river")`), mirroring today's single Node process. The Worker's `fetch()` handler does no work itself — it just forwards every request to that one DO instance, which does everything.

## Components

- **`worker/src/index.js`** — Worker entry point. Routes `GET /events` to the `AisRelay` Durable Object; anything else returns 404.
- **`worker/src/AisRelay.js`** — Durable Object class:
  - Constructor opens the AISStream WebSocket with the same bounding box (`[[39.05,-81.80],[39.42,-81.25]]`) and `FilterMessageTypes: ['PositionReport']` as `server.js` today.
  - Same reconnect/backoff: 5s initial delay, doubling, capped at 5 minutes.
  - In-memory `vessels: Map<mmsi, vessel>` and `Set` of open SSE writer streams, ported from `server.js`'s `vessels`/`clients`/`broadcast()`.
  - On new SSE connection: emits `snapshot` (full current vessel list) then `ais-connected` or `ais-reconnecting` (with `reconnectAt`), matching the current `/events` handler exactly.
  - Response to every `/events` request includes `Access-Control-Allow-Origin: https://jahart.github.io` (exact origin, not `*` — this is a public read-only stream so there's no real security cost either way, but pinning to the known origin is tighter for no extra effort).
  - Stale-vessel sweep (10-minute threshold) runs on a Durable Object `alarm()` that reschedules itself every 60s, replacing `server.js`'s `setInterval` (which isn't reliable in a DO that can be evicted between requests).
- **`worker/wrangler.toml`** — Worker + Durable Object binding config, deployed to the default `*.workers.dev` subdomain (no custom domain needed for this phase).
- **`standalone/index.html`** — Replace the `AISSTREAM_API_KEY` constant and the `new WebSocket('wss://stream.aisstream.io/...')` block (around line 365–1073) with an `EventSource` pointed at the Worker's `/events` URL. It parses the same `snapshot` / `update` / `remove` / `ais-connected` / `ais-reconnecting` message shapes `server.js` already emits, so all downstream logic — vessel rendering, lock-approach classification, danger-zone alerts — needs **no changes**, only the transport at the top of the file changes.
- **Deleted:** `server.js`, `public/app.js`, `public/index.html`, `package.json`'s `express`/`ws`/`dotenv` dependencies and `start`/`dev` scripts, and the ngrok section of `README.md`.

## Data flow / error handling

Identical semantics to `server.js` today, just relocated into the DO:
- AISStream `close` → schedule reconnect with existing exponential backoff, broadcast `ais-reconnecting` with the retry timestamp so the browser's existing "reconnecting" banner keeps working unmodified.
- AISStream `message` (PositionReport) → update `vessels` Map, broadcast `update` to all connected SSE clients.
- Browser disconnects (tab closed, etc.) → its writer stream is removed from the client Set (SSE `req.on('close')` equivalent).
- No changes to message JSON shape, so no changes needed to any client-side parsing/classification logic.

## Key rotation

Independent of and prior to all of the above: rotate the currently-exposed AISStream key at aisstream.io. The new key is set only via `wrangler secret put AISSTREAM_API_KEY` (or the Cloudflare dashboard) — it never appears in any file committed to the repo.

## Verification

1. Rotate the AISStream key first, regardless of deployment timing.
2. `wrangler dev` locally — confirm the SSE stream produces the same message shapes `server.js` did.
3. Deploy to `*.workers.dev`. Point a local copy of `standalone/index.html` at it (not yet the deployed GitHub Pages copy) and confirm the map, vessel list, lock-approach panel, and danger-zone alerts all behave identically to current production.
4. Only once step 3 is confirmed: update the deployed `standalone/index.html` on GitHub Pages and watch it live for a day.
5. Delete `server.js`, `public/`, and the ngrok README section only after step 4 has held for a day without issues.

## Out of scope for this phase

- USGS river data, river-conditions panel, rowing indicator, geometry-aware direction, map landmarks, historical conditions (Phases 2–8 of `docs/new_release_phases.md`).
- Vessel-type filtering or geographic sub-filtering beyond the existing bounding box (Phase 5 territory).
- Any change to the AIS message shape or client-side classification logic.
