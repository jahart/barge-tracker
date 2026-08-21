# Phase 1: AIS Relay via Cloudflare Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AISStream connection out of `standalone/index.html` (where the API key is currently hardcoded and shipped to every browser via GitHub Pages) into a Cloudflare Worker + Durable Object relay, and retire the local Express server (`server.js`) that solved this only for local/ngrok use.

**Architecture:** A single Durable Object (`AisRelay`) holds the one persistent AISStream WebSocket connection, keeps an in-memory vessel map, and serves an SSE stream (`GET /events`) to browsers. The Worker's `fetch()` handler does no work itself — it routes every request to that one Durable Object instance. `standalone/index.html` swaps its direct AISStream WebSocket connection for an `EventSource` pointed at the Worker.

**Tech Stack:** Cloudflare Workers, Durable Objects, `wrangler`, `vitest` (for the pure logic modules — the DO class itself is verified manually via `wrangler dev`, since it depends on Workers-runtime globals like `WebSocket` and `DurableObjectState` that aren't safely testable outside that runtime).

**Reference spec:** `docs/superpowers/specs/2026-08-21-phase1-ais-relay-design.md`

---

### Task 1: Scaffold the worker project

**Files:**
- Create: `worker/package.json`
- Create: `worker/wrangler.toml`
- Create: `worker/.gitignore`

- [ ] **Step 1: Create the worker directory and its package.json**

```json
{
  "name": "barge-tracker-worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.4",
    "wrangler": "^3.90.0"
  }
}
```

- [ ] **Step 2: Create wrangler.toml**

```toml
name = "barge-tracker-relay"
main = "src/index.js"
compatibility_date = "2026-08-21"

[[durable_objects.bindings]]
name = "AIS_RELAY"
class_name = "AisRelay"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AisRelay"]
```

- [ ] **Step 3: Create worker/.gitignore**

```
node_modules/
.wrangler/
.dev.vars
```

- [ ] **Step 4: Install dependencies**

Run: `cd worker && npm install`
Expected: installs `vitest` and `wrangler` with no errors, creates `worker/package-lock.json`.

- [ ] **Step 5: Verify wrangler is usable**

Run: `cd worker && npx wrangler --version`
Expected: prints a wrangler version number (e.g. `⛅️ wrangler 3.9x.x`), no login required yet for this command.

- [ ] **Step 6: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/wrangler.toml worker/.gitignore
git commit -m "chore: scaffold Cloudflare Worker project for AIS relay"
```

---

### Task 2: Backoff helper (reconnect delay math)

**Files:**
- Create: `worker/src/lib/backoff.js`
- Test: `worker/test/backoff.test.js`

- [ ] **Step 1: Write the failing test**

`worker/test/backoff.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { INITIAL_DELAY_MS, MAX_DELAY_MS, nextDelay } from '../src/lib/backoff.js';

describe('nextDelay', () => {
  it('doubles the current delay', () => {
    expect(nextDelay(INITIAL_DELAY_MS)).toBe(INITIAL_DELAY_MS * 2);
  });

  it('caps a value that would double past the max', () => {
    expect(nextDelay(4 * 60 * 1000)).toBe(MAX_DELAY_MS);
  });

  it('stays capped once already at the max', () => {
    expect(nextDelay(MAX_DELAY_MS)).toBe(MAX_DELAY_MS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/backoff.test.js`
Expected: FAIL — `Cannot find module '../src/lib/backoff.js'`

- [ ] **Step 3: Write minimal implementation**

`worker/src/lib/backoff.js`:

```js
export const INITIAL_DELAY_MS = 5000;
export const MAX_DELAY_MS = 5 * 60 * 1000;

export function nextDelay(currentDelayMs) {
  return Math.min(currentDelayMs * 2, MAX_DELAY_MS);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/backoff.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/backoff.js worker/test/backoff.test.js
git commit -m "feat: add reconnect backoff helper"
```

---

### Task 3: Vessel parsing and staleness helpers

**Files:**
- Create: `worker/src/lib/vessels.js`
- Test: `worker/test/vessels.test.js`

- [ ] **Step 1: Write the failing tests**

`worker/test/vessels.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parsePositionReport, findStale, STALE_THRESHOLD_MS } from '../src/lib/vessels.js';

describe('parsePositionReport', () => {
  it('returns null for non-PositionReport messages', () => {
    expect(parsePositionReport({ MessageType: 'ShipStaticData' }, 1000)).toBeNull();
  });

  it('parses a PositionReport into a vessel object', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { ShipName: '  M/V EXAMPLE  ' },
      Message: {
        PositionReport: { UserID: 123456789, Latitude: 39.2, Longitude: -81.5, Sog: 5.2, Cog: 180 },
      },
    };
    expect(parsePositionReport(msg, 1000)).toEqual({
      mmsi: '123456789',
      name: 'M/V EXAMPLE',
      lat: 39.2,
      lon: -81.5,
      sog: 5.2,
      cog: 180,
      updatedAt: 1000,
    });
  });

  it('falls back to "MMSI <id>" when ShipName is blank', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { ShipName: '   ' },
      Message: {
        PositionReport: { UserID: 987654321, Latitude: 39.3, Longitude: -81.4, Sog: 0, Cog: 0 },
      },
    };
    expect(parsePositionReport(msg, 1000).name).toBe('MMSI 987654321');
  });
});

describe('findStale', () => {
  it('returns nothing when all vessels are within the threshold', () => {
    const vessels = new Map([
      ['1', { mmsi: '1', updatedAt: 0 }],
      ['2', { mmsi: '2', updatedAt: 9000 }],
    ]);
    expect(findStale(vessels, 10000, STALE_THRESHOLD_MS)).toEqual([]);
  });

  it('returns mmsi of vessels older than the threshold', () => {
    const vessels = new Map([
      ['1', { mmsi: '1', updatedAt: 0 }],
      ['2', { mmsi: '2', updatedAt: 9000 }],
    ]);
    const now = 9000 + STALE_THRESHOLD_MS + 1;
    expect(findStale(vessels, now, STALE_THRESHOLD_MS)).toEqual(['1', '2']);
  });

  it('keeps a vessel exactly at the threshold', () => {
    const vessels = new Map([['1', { mmsi: '1', updatedAt: 1000 }]]);
    expect(findStale(vessels, 1000 + STALE_THRESHOLD_MS, STALE_THRESHOLD_MS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/vessels.test.js`
Expected: FAIL — `Cannot find module '../src/lib/vessels.js'`

- [ ] **Step 3: Write minimal implementation**

`worker/src/lib/vessels.js`:

```js
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;

export function parsePositionReport(msg, now) {
  if (!msg || msg.MessageType !== 'PositionReport') return null;

  const pos = msg.Message && msg.Message.PositionReport;
  if (!pos) return null;

  const meta = msg.MetaData || {};
  const name = (meta.ShipName || '').trim();

  return {
    mmsi: String(pos.UserID),
    name: name || `MMSI ${pos.UserID}`,
    lat: pos.Latitude,
    lon: pos.Longitude,
    sog: pos.Sog,
    cog: pos.Cog,
    updatedAt: now,
  };
}

export function findStale(vessels, now, thresholdMs = STALE_THRESHOLD_MS) {
  const stale = [];
  for (const [mmsi, vessel] of vessels) {
    if (now - vessel.updatedAt > thresholdMs) stale.push(mmsi);
  }
  return stale;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/vessels.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/vessels.js worker/test/vessels.test.js
git commit -m "feat: add AIS position parsing and stale-vessel helpers"
```

---

### Task 4: AisRelay Durable Object

This class depends on Workers-runtime-only globals (`WebSocket`, `DurableObjectState`, `TransformStream` backed by the real Workers streams implementation) that cannot be safely instantiated or mocked in plain Node/vitest. Per the design spec's Verification section, this task is verified manually with `wrangler dev` rather than an automated unit test — the pure logic it depends on (`backoff.js`, `vessels.js`) is already covered by Tasks 2–3.

**Files:**
- Create: `worker/src/AisRelay.js`

- [ ] **Step 1: Write the Durable Object class**

`worker/src/AisRelay.js`:

```js
import { INITIAL_DELAY_MS, nextDelay } from './lib/backoff.js';
import { parsePositionReport, findStale, STALE_THRESHOLD_MS } from './lib/vessels.js';

const BOUNDING_BOX = [[39.05, -81.80], [39.42, -81.25]];
const SWEEP_INTERVAL_MS = 60 * 1000;
const CORS_ORIGIN = 'https://jahart.github.io';

export class AisRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.vessels = new Map();
    this.clients = new Set();
    this.aisConnected = false;
    this.reconnectAt = null;
    this.reconnectDelay = INITIAL_DELAY_MS;

    this.state.blockConcurrencyWhile(async () => {
      this.connectAis();
      const alarm = await this.state.storage.getAlarm();
      if (alarm === null) {
        await this.state.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      }
    });
  }

  connectAis() {
    if (!this.env.AISSTREAM_API_KEY) {
      console.warn('AISSTREAM_API_KEY not set — running without live data');
      return;
    }

    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    ws.addEventListener('open', () => {
      this.reconnectDelay = INITIAL_DELAY_MS;
      this.aisConnected = true;
      this.reconnectAt = null;
      this.broadcast({ type: 'ais-connected' });
      ws.send(JSON.stringify({
        APIKey: this.env.AISSTREAM_API_KEY,
        BoundingBoxes: [BOUNDING_BOX],
        FilterMessageTypes: ['PositionReport'],
      }));
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleAisMessage(msg, Date.now());
      } catch (err) {
        console.error('AIS parse error:', err.message);
      }
    });

    ws.addEventListener('error', (err) => {
      console.error('AISStream error:', err.message || err);
    });

    ws.addEventListener('close', () => {
      this.aisConnected = false;
      this.reconnectAt = Date.now() + this.reconnectDelay;
      this.broadcast({ type: 'ais-reconnecting', reconnectAt: this.reconnectAt });
      setTimeout(() => this.connectAis(), this.reconnectDelay);
      this.reconnectDelay = nextDelay(this.reconnectDelay);
    });
  }

  handleAisMessage(msg, now) {
    const vessel = parsePositionReport(msg, now);
    if (!vessel) return;
    this.vessels.set(vessel.mmsi, vessel);
    this.broadcast({ type: 'update', vessel });
  }

  broadcast(payload) {
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
    for (const writer of this.clients) {
      writer.write(chunk).catch(() => this.clients.delete(writer));
    }
  }

  async alarm() {
    const now = Date.now();
    for (const mmsi of findStale(this.vessels, now, STALE_THRESHOLD_MS)) {
      this.vessels.delete(mmsi);
      this.broadcast({ type: 'remove', mmsi });
    }
    await this.state.storage.setAlarm(now + SWEEP_INTERVAL_MS);
  }

  async fetch(request) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    this.clients.add(writer);

    // Do NOT await these writes: nothing reads `readable` until the Response
    // below is actually returned and the runtime starts consuming it, so an
    // awaited write here would block on backpressure forever and the request
    // would be killed as hung.
    const encoder = new TextEncoder();
    const snapshot = { type: 'snapshot', vessels: [...this.vessels.values()] };
    writer.write(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`)).catch(() => this.clients.delete(writer));

    const status = this.aisConnected
      ? { type: 'ais-connected' }
      : { type: 'ais-reconnecting', reconnectAt: this.reconnectAt };
    writer.write(encoder.encode(`data: ${JSON.stringify(status)}\n\n`)).catch(() => this.clients.delete(writer));

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      },
    });
  }
}
```

- [ ] **Step 2: Manual smoke test with wrangler dev (no API key needed for this step)**

Run: `cd worker && npx wrangler dev`
Then in a second terminal: `curl -N http://localhost:8787/events`
Expected: the curl connection stays open and immediately prints two SSE lines:
```
data: {"type":"snapshot","vessels":[]}

data: {"type":"ais-reconnecting","reconnectAt":null}
```
(The second line reads `ais-reconnecting` with `reconnectAt: null` because `AISSTREAM_API_KEY` isn't set yet in local dev — that's expected at this step. `connectAis()` should have logged `AISSTREAM_API_KEY not set — running without live data` in the `wrangler dev` terminal.)
Stop both processes with Ctrl+C once confirmed.

- [ ] **Step 3: Commit**

```bash
git add worker/src/AisRelay.js
git commit -m "feat: implement AisRelay Durable Object (AIS relay + SSE broadcast)"
```

---

### Task 5: Worker entry point and routing

**Files:**
- Create: `worker/src/index.js`
- Test: `worker/test/index.test.js`

- [ ] **Step 1: Write the failing tests**

`worker/test/index.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';

describe('worker fetch routing', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await worker.fetch(new Request('https://relay.example/nope'), {});
    expect(res.status).toBe(404);
  });

  it('forwards GET /events to the AisRelay Durable Object stub', async () => {
    const stubResponse = new Response('ok');
    const stub = { fetch: vi.fn().mockResolvedValue(stubResponse) };
    const env = {
      AIS_RELAY: {
        idFromName: vi.fn().mockReturnValue('id-ohio-river'),
        get: vi.fn().mockReturnValue(stub),
      },
    };
    const request = new Request('https://relay.example/events');
    const res = await worker.fetch(request, env);

    expect(env.AIS_RELAY.idFromName).toHaveBeenCalledWith('ohio-river');
    expect(env.AIS_RELAY.get).toHaveBeenCalledWith('id-ohio-river');
    expect(stub.fetch).toHaveBeenCalledWith(request);
    expect(res).toBe(stubResponse);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/index.test.js`
Expected: FAIL — `Cannot find module '../src/index.js'`

- [ ] **Step 3: Write minimal implementation**

`worker/src/index.js`:

```js
import { AisRelay } from './AisRelay.js';

export { AisRelay };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/events' && request.method === 'GET') {
      const id = env.AIS_RELAY.idFromName('ohio-river');
      const stub = env.AIS_RELAY.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/index.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full worker test suite**

Run: `cd worker && npx vitest run`
Expected: PASS (11 tests total across backoff, vessels, index)

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js worker/test/index.test.js
git commit -m "feat: add Worker entry point routing /events to AisRelay"
```

---

### Task 6: Rotate the AISStream key and verify live locally

This task is entirely manual (account/secret setup) — no code changes.

**Files:** none

- [ ] **Step 1: Rotate the exposed key**

Go to https://aisstream.io, revoke the old API key (the one previously in `standalone/index.html`), and generate a new one. Do this regardless of how far along the rest of this plan is — the old key must be considered permanently compromised since it was committed to a public repo.

- [ ] **Step 2: Log in to Cloudflare via wrangler**

Run: `cd worker && npx wrangler login`
Expected: opens a browser window to authorize wrangler against your Cloudflare account (create a free account first at https://dash.cloudflare.com/sign-up if you don't have one), then prints `Successfully logged in.`

- [ ] **Step 3: Set the new key as a local dev secret**

Run: `cd worker && echo "AISSTREAM_API_KEY=your-new-key-here" > .dev.vars`

(`.dev.vars` is already in `worker/.gitignore` from Task 1 — it will never be committed.)

- [ ] **Step 4: Verify the live AISStream connection locally**

Run: `cd worker && npx wrangler dev`
Then in a second terminal: `curl -N http://localhost:8787/events`
Expected: within a few seconds, the `wrangler dev` terminal logs vessel position updates being received, and the curl output shows `data: {"type":"ais-connected"}` followed by `data: {"type":"update","vessel":{...}}` lines as real vessels are seen in the bounding box.
Stop both processes with Ctrl+C once confirmed.

(No commit — this task only sets up local secrets and account access.)

---

### Task 7: Deploy the Worker

**Files:** none (deployment only)

- [ ] **Step 1: Set the production secret**

Run: `cd worker && npx wrangler secret put AISSTREAM_API_KEY`
When prompted, paste the same rotated key from Task 6.
Expected: `Success! Uploaded secret AISSTREAM_API_KEY`

- [ ] **Step 2: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: prints a deployed URL of the form `https://barge-tracker-relay.<your-subdomain>.workers.dev`. Note this URL — it's needed in Task 8.

- [ ] **Step 3: Verify the deployed endpoint**

Run: `curl -N https://barge-tracker-relay.<your-subdomain>.workers.dev/events` (substitute your actual URL from Step 2)
Expected: same behavior as the local verification in Task 6 Step 4 — a `snapshot` line, then `ais-connected`, then live `update` lines.
Stop with Ctrl+C once confirmed.

(No commit — deployment only. `wrangler.toml` already reflects the deployed configuration from Task 1.)

---

### Task 8: Point standalone/index.html at the Worker

**Files:**
- Modify: `standalone/index.html:363-384` (remove the hardcoded key and now-unused bounding box constant)
- Modify: `standalone/index.html:993-1091` (replace the AISStream WebSocket connection with an EventSource client)
- Modify: `standalone/index.html:1108` (update the startup call)

- [ ] **Step 1: Remove the hardcoded key and the now-unused BOUNDING_BOX constant**

In `standalone/index.html`, replace (around lines 363–379):

```js
/*
 * IMPORTANT:
 * Replace this with a NEW AISStream key.
 * The key previously pasted into ChatGPT should be considered exposed.
 */
const AISSTREAM_API_KEY = 'REPLACE_WITH_NEW_AISSTREAM_KEY';

const OVRC            = [39.2833, -81.5631];
const ZONE_CENTER     = [39.2851, -81.5631];
const DANGER_RADIUS_M = 4828;
const MAP_CENTER      = [39.2900, -81.5631];
const MAP_ZOOM        = 13;

const BOUNDING_BOX = [
  [39.05, -81.80],
  [39.42, -81.25]
];

const STALE_MS        = 10 * 60 * 1000;
```

with:

```js
/*
 * Vessel data is relayed through a Cloudflare Worker so the AISStream
 * API key never ships to the browser. See worker/README.md.
 */
const RELAY_EVENTS_URL = 'https://barge-tracker-relay.<your-subdomain>.workers.dev/events';

const OVRC            = [39.2833, -81.5631];
const ZONE_CENTER     = [39.2851, -81.5631];
const DANGER_RADIUS_M = 4828;
const MAP_CENTER      = [39.2900, -81.5631];
const MAP_ZOOM        = 13;

const STALE_MS        = 10 * 60 * 1000;
```

Substitute `<your-subdomain>` with the actual URL noted in Task 7, Step 2.

- [ ] **Step 2: Replace the AISStream connection block with an EventSource client**

Replace (around lines 993–1091, from the `AISSTREAM` section comment through the end of `connectAIS()`):

```js
/* ==========================================================================
   AISSTREAM
   ========================================================================== */

const RECONNECT_MS = 5000;
const MAX_RECONNECT_MS = 5 * 60 * 1000;

let reconnectDelay = RECONNECT_MS;

function connectAIS() {
  const ws = new WebSocket(
    'wss://stream.aisstream.io/v0/stream'
  );

  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MS;

    console.log('AISStream connected');

    clearReconnecting();

    ws.send(JSON.stringify({
      APIKey: AISSTREAM_API_KEY,
      BoundingBoxes: [BOUNDING_BOX],
      FilterMessageTypes: ['PositionReport']
    }));
  });

  ws.addEventListener('message', async e => {
    try {
      const text =
        e.data instanceof Blob
          ? await e.data.text()
          : e.data;

      const msg = JSON.parse(text);

      if (
        msg.MessageType !==
        'PositionReport'
      ) return;

      const pos =
        msg.Message.PositionReport;

      const meta =
        msg.MetaData || {};

      applyVessel({
        mmsi: String(pos.UserID),
        name:
          (meta.ShipName || '').trim() ||
          `MMSI ${pos.UserID}`,
        lat: pos.Latitude,
        lon: pos.Longitude,
        sog: pos.Sog,
        cog: pos.Cog,
        updatedAt: Date.now()
      });

    } catch (err) {
      console.error(
        'AIS parse error:',
        err
      );
    }
  });

  ws.addEventListener('error', e => {
    console.error(
      'AISStream error',
      e
    );
  });

  ws.addEventListener('close', () => {
    const reconnectAt =
      Date.now() + reconnectDelay;

    console.log(
      `AISStream disconnected — reconnecting in ${
        reconnectDelay / 1000
      }s`
    );

    showReconnecting(reconnectAt);

    setTimeout(
      connectAIS,
      reconnectDelay
    );

    reconnectDelay =
      Math.min(
        reconnectDelay * 2,
        MAX_RECONNECT_MS
      );
  });
}
```

with:

```js
/* ==========================================================================
   RELAY (Cloudflare Worker)
   ========================================================================== */

function connectRelay() {
  const source = new EventSource(RELAY_EVENTS_URL);

  source.onmessage = e => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case 'snapshot':
        msg.vessels.forEach(applyVessel);
        clearReconnecting();
        break;

      case 'update':
        applyVessel(msg.vessel);
        break;

      case 'remove':
        removeVessel(msg.mmsi);
        break;

      case 'ais-connected':
        clearReconnecting();
        break;

      case 'ais-reconnecting':
        showReconnecting(msg.reconnectAt);
        break;
    }
  };

  source.onerror = () => {
    console.error('Relay connection error — browser will retry automatically');
  };
}
```

- [ ] **Step 3: Update the startup call**

Replace (around line 1108):

```js
/* Start */
connectAIS();
syncMapOffset();
```

with:

```js
/* Start */
connectRelay();
syncMapOffset();
```

- [ ] **Step 4: Manual verification against the deployed Worker**

Open `standalone/index.html` directly in a browser (`file://` path is fine — `EventSource` works across origins same as before). Confirm:
- The map loads and the "Connecting to AIS…" placeholder is replaced by real vessel entries (or stays empty if no vessels are currently in the bounding box — check the browser console for `data:` events being received).
- The lock-approach panel (`↑ From Belleville` / `↓ From Willow Island`) still populates correctly when applicable.
- The danger-zone alert still fires (can be checked by temporarily lowering `DANGER_RADIUS_M` and confirming a nearby vessel triggers it, then reverting).
- Open browser devtools → Network tab, confirm the `/events` request shows type `eventsource` and status 200, with no CORS errors in the console.

Do not proceed to Step 5 until this manual check passes.

- [ ] **Step 5: Commit**

```bash
git add standalone/index.html
git commit -m "feat: connect standalone tracker to Cloudflare Worker relay instead of AISStream directly"
```

---

### Task 9: Deploy to GitHub Pages and watch

**Files:** none (deployment/observation only)

- [ ] **Step 1: Push the commit from Task 8 to the branch GitHub Pages serves**

Confirm with the user which branch/workflow publishes `standalone/index.html` to `https://jahart.github.io/barge-tracker` before pushing, since this plan doesn't assume a specific CI setup.

- [ ] **Step 2: Watch the live page**

Over the next 24 hours, periodically check `https://jahart.github.io/barge-tracker` in a browser: vessels should keep appearing/updating/disappearing, and the reconnect banner (if it ever shows) should clear on its own. Check the Worker's logs for errors: `cd worker && npx wrangler tail`.

**Do not start Task 10 until this has held for at least 24 hours without issues** (per the design spec's verification gate) — this task has no automated way to satisfy that condition, so treat it as a manual go/no-go checkpoint before the next task deletes the fallback path.

---

### Task 10: Retire the local Express server

**Do not start this task until Task 9's 24-hour watch has passed cleanly.**

**Files:**
- Delete: `server.js`
- Delete: `public/app.js`
- Delete: `public/index.html`
- Modify: `package.json` (root)
- Modify: `README.md` (root)

- [ ] **Step 1: Delete the retired files**

```bash
git rm server.js public/app.js public/index.html
```

- [ ] **Step 2: Remove the now-unused dependencies and scripts from the root package.json**

Read the current root `package.json`, remove the `dependencies` block (`dotenv`, `express`, `ws`) and the `scripts.start`/`scripts.dev` entries that ran `server.js`, since nothing in the repo runs a Node server anymore. Leave `name`, `version`, `description`, and `main` as-is unless they specifically reference `server.js` (`main` currently does — remove that field too, since there's no longer an entry point to point at).

- [ ] **Step 3: Update the root README**

Replace the "Setup" and "Viewing on your phone via ngrok" sections with:

```md
## Architecture

`standalone/index.html` is a static page (served via GitHub Pages) that reads vessel positions from a small Cloudflare Worker relay in `worker/`. The Worker holds the AISStream API key as a secret and maintains the live AISStream connection server-side — the key is never shipped to the browser. See `worker/README.md` for the relay's own setup/deploy steps.

## Local development

1. `cd worker && npm install`
2. Create `worker/.dev.vars` with `AISSTREAM_API_KEY=your_key_here` (get a free key at https://aisstream.io)
3. `npx wrangler dev`
4. Open `standalone/index.html` and set `RELAY_EVENTS_URL` to the printed `http://localhost:8787/events` URL for local testing.
```

Keep the existing "Danger zone" and "AIS coverage note" sections unchanged.

- [ ] **Step 4: Create worker/README.md**

```md
# Barge Tracker Relay (Cloudflare Worker)

Holds the AISStream API key server-side and relays vessel positions to `standalone/index.html` over Server-Sent Events, so the key is never shipped to the browser.

## Setup

1. `npm install`
2. `npx wrangler login`
3. Get a free AISStream API key at https://aisstream.io
4. Local dev: create `.dev.vars` with `AISSTREAM_API_KEY=your_key_here`, then `npx wrangler dev`
5. Deploy: `npx wrangler secret put AISSTREAM_API_KEY` (paste your key when prompted), then `npx wrangler deploy`

## Tests

`npx vitest run` — covers the reconnect-backoff and AIS-message-parsing logic. The `AisRelay` Durable Object itself is verified manually via `wrangler dev` (see the main repo's implementation plan under `docs/superpowers/plans/`), since it depends on Workers-runtime globals that aren't safely testable outside that runtime.
```

- [ ] **Step 5: Verify nothing else references the deleted files**

Run: `grep -rn "server.js\|public/app.js\|ngrok" --include="*.md" --include="*.json" --include="*.html" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=worker`
Expected: no remaining references (aside from this plan document and the design spec, which are historical records and are excluded from this grep by not matching those patterns in `docs/`... confirm manually if any hits appear in `docs/`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: retire local Express server now that the Cloudflare Worker relay is live"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 4–5), components (Tasks 1–5, 8), data flow/error handling (Task 4, ported 1:1 from `server.js`), key rotation (Task 6 Step 1), verification steps 1–5 from the spec (Tasks 6–9 map directly to spec verification steps 1–5), deletion of `server.js`/`public/`/ngrok (Task 10). CORS origin lock to `https://jahart.github.io` is in Task 4's `AisRelay.js`.
- **Type consistency:** `parsePositionReport`/`findStale` signatures match between their definition (Task 3) and their use in `AisRelay.js` (Task 4). The SSE message `type` values (`snapshot`, `update`, `remove`, `ais-connected`, `ais-reconnecting`) are consistent between the Worker's `broadcast()`/`fetch()` (Task 4) and the client's `connectRelay()` switch (Task 8).
- **No placeholders:** The one open value in the plan (`<your-subdomain>` in Task 8) is a real deployment-time value that can only be known after Task 7's `wrangler deploy` output — not an unfinished-logic placeholder — and Task 8 explicitly instructs where to get it.
