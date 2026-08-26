# Lock Traffic (USACE Lock Queue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, independent barge-traffic signal — USACE lock lockage data for Belleville and Willow Island — published as `lock-traffic.json` via a scheduled GitHub Actions workflow, and restructure `index.html` into two full-screen tabs ("Map & Vessels" unchanged, new "Traffic Log" holding River Conditions + the new Lock Traffic panel).

**Architecture:** A small Node script (`scripts/update-lock-traffic.mjs`) fetches USACE's public `lock_queue_json` endpoint for both locks, shapes each response with a pure, unit-tested function (`scripts/shape-lock-traffic.mjs`), and writes `lock-traffic.json` to the repo root — mirroring `river.json`'s existing pipeline exactly, including its retry/timeout/stale-tolerance behavior (extracted into a new shared `scripts/lib/fetch-with-retry.mjs` used by both scripts). A standalone GitHub Actions workflow runs it on an offset 30-minute cron and commits the result. `index.html` gains a tab bar; the map/AIS experience is unchanged on "Map & Vessels," and River Conditions moves into the new full-screen "Traffic Log" tab alongside the new Lock Traffic panel.

**Tech Stack:** Plain Node.js (native `fetch`, ES modules, no new dependencies), Node's built-in `node:test` runner, GitHub Actions (`schedule` + `workflow_dispatch`), vanilla JS/CSS in `index.html` (no framework).

**Reference spec:** `docs/superpowers/specs/2026-08-26-lock-traffic-design.md`

---

### Task 1: Extract shared fetch-with-retry helper

The timeout+retry logic currently lives only inside `scripts/update-river-conditions.mjs`. Moving it to a shared module lets `update-lock-traffic.mjs` (Task 3) reuse it instead of duplicating ~25 lines. This is a pure extraction — behavior must not change.

**Files:**
- Create: `scripts/lib/fetch-with-retry.mjs`
- Modify: `scripts/update-river-conditions.mjs:1-41`

- [ ] **Step 1: Create the shared module**

`scripts/lib/fetch-with-retry.mjs`:

```js
const FETCH_TIMEOUT_MS = 10_000;
const RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}
```

This is copied verbatim from the current top of `scripts/update-river-conditions.mjs` (its `fetchJson`/`withRetry`/`sleep`/timing constants), just relocated and exported.

- [ ] **Step 2: Update `update-river-conditions.mjs` to import from the shared module**

In `scripts/update-river-conditions.mjs`, replace lines 1-41 (everything from the top through the end of the `withRetry` function):

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTrend } from './compute-trend.mjs';

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

const USGS_URL =
  'https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json';
const NWS_URL = 'https://api.water.noaa.gov/nwps/v1/gauges/parw2';

const FETCH_TIMEOUT_MS = 10_000;
const RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}
```

with:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTrend } from './compute-trend.mjs';
import { fetchJson, withRetry } from './lib/fetch-with-retry.mjs';

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

const USGS_URL =
  'https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json';
const NWS_URL = 'https://api.water.noaa.gov/nwps/v1/gauges/parw2';
```

The rest of the file (`fetchStageAndTrend`, `fetchFloodCategory`, `main`, the stale-fallback `catch` block) is unchanged — they already call `fetchJson`/`withRetry` by name, which now resolve via the import instead of a local definition.

- [ ] **Step 3: Verify the refactor didn't break anything**

Run: `node scripts/update-river-conditions.mjs`
Expected: prints `Wrote river.json: { stageFt: <number>, trend: ..., floodCategory: ..., updated: ... }` exactly as before — same real USGS/NWS data, since no logic changed, only where it lives.

Run: `rm river.json` afterward — this file should only ever be written by the scheduled workflow, not committed from a local run.

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/fetch-with-retry.mjs scripts/update-river-conditions.mjs
git commit -m "refactor: extract fetch-with-retry helper for reuse by lock-traffic script"
```

---

### Task 2: Lock queue shaping helper (pure logic, TDD)

**Files:**
- Create: `scripts/shape-lock-traffic.mjs`
- Test: `scripts/shape-lock-traffic.test.mjs`

- [ ] **Step 1: Write the failing tests**

`scripts/shape-lock-traffic.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeLockQueue } from './shape-lock-traffic.mjs';

test('normalizes USACE MM/DD/YY date format to ISO-8601 with a fixed UTC-5 offset', () => {
  const result = shapeLockQueue([
    {
      vesselName: 'GLENN A HENDON',
      vesselNo: '0625977',
      direction: 'U',
      numBarges: 11,
      SOLdate: '08/11/26 20:09',
      arrivalDate: '08/11/26 19:20',
      endOfLockage: '08/11/26 20:48',
      timezone: 'EST',
      MMSI: 367375080,
    },
  ]);

  assert.equal(result.recentLockages[0].endOfLockage, '2026-08-11T20:48:00-05:00');
});

test('passes through vesselName, direction, numBarges, and mmsi unchanged', () => {
  const result = shapeLockQueue([
    {
      vesselName: 'CANTON',
      vesselNo: '1224197',
      direction: 'D',
      numBarges: 6,
      SOLdate: '08/19/26 03:06',
      arrivalDate: '08/19/26 03:05',
      endOfLockage: '08/19/26 04:24',
      timezone: 'EST',
      MMSI: 367433690,
    },
  ]);

  assert.deepEqual(result.recentLockages[0], {
    vesselName: 'CANTON',
    direction: 'D',
    numBarges: 6,
    endOfLockage: '2026-08-19T04:24:00-05:00',
    mmsi: 367433690,
  });
});

test('caps recentLockages at the 5 most recent entries, preserving newest-first order', () => {
  const raw = Array.from({ length: 8 }, (_, i) => ({
    vesselName: `VESSEL ${i}`,
    vesselNo: String(i),
    direction: 'U',
    numBarges: 1,
    SOLdate: '08/19/26 04:00',
    arrivalDate: '08/19/26 03:55',
    endOfLockage: '08/19/26 04:24',
    timezone: 'EST',
    MMSI: 100000 + i,
  }));

  const result = shapeLockQueue(raw);

  assert.equal(result.recentLockages.length, 5);
  assert.equal(result.recentLockages[0].vesselName, 'VESSEL 0');
  assert.equal(result.recentLockages[4].vesselName, 'VESSEL 4');
});

test('handles an empty array (no lockages in the past 30 days)', () => {
  const result = shapeLockQueue([]);
  assert.deepEqual(result.recentLockages, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/shape-lock-traffic.test.mjs`
Expected: FAIL — `Cannot find module './shape-lock-traffic.mjs'`

- [ ] **Step 3: Write minimal implementation**

`scripts/shape-lock-traffic.mjs`:

```js
const LOCKAGE_LIMIT = 5;

// USACE's lock_queue_json labels every timestamp "EST" regardless of time of
// year (confirmed against real August data during design) — it's not
// DST-aware, so this is a fixed UTC-5 offset, not a real IANA zone lookup.
function toIso8601(usaceDateStr) {
  const [datePart, timePart] = usaceDateStr.split(' ');
  const [month, day, yy] = datePart.split('/');
  const year = 2000 + Number(yy);
  return `${year}-${month}-${day}T${timePart}:00-05:00`;
}

export function shapeLockQueue(rawArray) {
  const recentLockages = rawArray.slice(0, LOCKAGE_LIMIT).map((entry) => ({
    vesselName: entry.vesselName,
    direction: entry.direction,
    numBarges: entry.numBarges,
    endOfLockage: toIso8601(entry.endOfLockage),
    mmsi: entry.MMSI,
  }));

  return { recentLockages };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/shape-lock-traffic.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/shape-lock-traffic.mjs scripts/shape-lock-traffic.test.mjs
git commit -m "feat: add lock queue shaping helper"
```

---

### Task 3: Main lock-traffic fetch script

This script calls a real external API directly, so — same judgment call as `update-river-conditions.mjs` — it isn't unit-tested; it's verified by actually running it against the live USACE endpoint and inspecting the output.

**Files:**
- Create: `scripts/update-lock-traffic.mjs`

- [ ] **Step 1: Write the script**

`scripts/update-lock-traffic.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchJson, withRetry } from './lib/fetch-with-retry.mjs';
import { shapeLockQueue } from './shape-lock-traffic.mjs';

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

const LOCKS = [
  { key: 'belleville', name: 'Belleville Locks and Dam', lockNo: '21' },
  { key: 'willowIsland', name: 'Willow Island Locks and Dam', lockNo: '72' },
];

const lockQueueUrl = (lockNo) =>
  `https://ndc.ops.usace.army.mil/ords/lpms/json/lock_queue_json?in_river=OH&in_lock=${lockNo}`;

async function fetchLockQueue(lockNo) {
  return withRetry(async () => {
    const data = await fetchJson(lockQueueUrl(lockNo));
    if (!Array.isArray(data)) {
      throw new Error(`Lock ${lockNo} response is not an array`);
    }
    return data;
  });
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockTrafficJsonPath = join(repoRoot, 'lock-traffic.json');

function lastUpdateAgeMs() {
  const existing = JSON.parse(readFileSync(lockTrafficJsonPath, 'utf8'));
  return Date.now() - Date.parse(existing.updated);
}

async function main() {
  const entries = await Promise.all(
    LOCKS.map(async (lock) => {
      const raw = await fetchLockQueue(lock.lockNo);
      return [lock.key, { name: lock.name, ...shapeLockQueue(raw) }];
    })
  );

  const output = {
    updated: new Date().toISOString(),
    locks: Object.fromEntries(entries),
  };

  writeFileSync(lockTrafficJsonPath, JSON.stringify(output, null, 2) + '\n');

  console.log('Wrote lock-traffic.json:', output);
}

main().catch((err) => {
  console.error('Failed to update lock traffic:', err);

  let ageMs;
  try {
    ageMs = lastUpdateAgeMs();
  } catch {
    ageMs = Infinity; // no prior data to fall back on — treat as a real outage
  }

  if (ageMs < STALE_THRESHOLD_MS) {
    console.warn(
      `lock-traffic.json is only ${Math.round(ageMs / 60_000)}m old — within the ${STALE_THRESHOLD_MS / 3_600_000}h tolerance, not failing the job.`
    );
    process.exit(0);
  }

  console.error(`lock-traffic.json has been stale for over ${STALE_THRESHOLD_MS / 3_600_000}h — failing the job.`);
  process.exit(1);
});
```

- [ ] **Step 2: Run it against the real API and verify the output**

Run: `node scripts/update-lock-traffic.mjs`
Expected: prints `Wrote lock-traffic.json: { updated: '<ISO timestamp>', locks: { belleville: { name: 'Belleville Locks and Dam', recentLockages: [...] }, willowIsland: { name: 'Willow Island Locks and Dam', recentLockages: [...] } } }`, and creates `lock-traffic.json` at the repo root.

- [ ] **Step 3: Inspect the generated file**

Run: `cat lock-traffic.json`
Expected: valid JSON matching the shape in the spec — each lock's `recentLockages` has at most 5 entries, each with `vesselName`, `direction` (`"U"` or `"D"`), `numBarges`, `endOfLockage` (ISO-8601 string ending in `-05:00`), and `mmsi` (a number).

- [ ] **Step 4: Remove the local test artifact before committing**

`lock-traffic.json` at the repo root should only ever be written by the scheduled workflow, not committed from a local run.

Run: `rm lock-traffic.json`

- [ ] **Step 5: Commit**

```bash
git add scripts/update-lock-traffic.mjs
git commit -m "feat: add script to fetch USACE lock queue data into lock-traffic.json"
```

---

### Task 4: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/lock-traffic.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/lock-traffic.yml`:

```yaml
name: Update lock traffic

on:
  schedule:
    - cron: '5,35 * * * *'
  workflow_dispatch: {}

permissions:
  contents: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22'

      - name: Fetch lock traffic and write lock-traffic.json
        run: node scripts/update-lock-traffic.mjs

      - name: Commit and push lock-traffic.json
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add lock-traffic.json
          git diff --staged --quiet || (git commit -m "chore: update lock traffic" && git push)
```

This mirrors `.github/workflows/river-conditions.yml` exactly (same actions versions, same conditional-commit pattern), except the cron is offset (`5,35` instead of `*/30`) so the two workflows' `git push` calls to `main` never land in the same minute and race each other, and it's a fully separate workflow file so a failure in one job can never block the other's commit step.

- [ ] **Step 2: Validate the YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/lock-traffic.yml'))" && echo "YAML OK"`
Expected: `YAML OK`

(If `pyyaml` isn't installed, run `pip3 install pyyaml` first — this is only a local syntax sanity check, not a project dependency.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/lock-traffic.yml
git commit -m "feat: add scheduled workflow to publish lock-traffic.json"
```

- [ ] **Step 4: After pushing (Task 8), verify the workflow actually runs**

This can't be verified until the workflow is on `main` (GitHub Actions `schedule` triggers only fire from the default branch). After Task 8's push, trigger it manually from the GitHub Actions tab ("Update lock traffic" → "Run workflow") rather than waiting for the next `:05`/`:35`, then confirm `lock-traffic.json` appears at the repo root on GitHub with real values.

---

### Task 5: Restructure `index.html` into a tabbed layout (CSS + HTML)

This splits the page into two full-screen tabs: "Map & Vessels" (today's experience, unchanged) and a new "Traffic Log" (River Conditions, moved here, plus the new Lock Traffic panel). No JS behavior changes yet — that's Task 6.

**Files:**
- Modify: `index.html:32-55` (CSS: new tab styles + offset adjustments)
- Modify: `index.html:278-344` (HTML body structure)

- [ ] **Step 1: Add tab CSS and adjust fixed-offset CSS for the new tab bar**

The tab bar sits below the existing top bar (which the codebase already treats as 57px tall — see `#alert-banner`'s and `#map`'s existing `top:57px`). Adding a ~44px tab bar shifts those offsets down by 44px.

Replace (around line 32-55):

```css
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.8)} }

#alert-banner {
  position:fixed; top:57px; left:0; right:0; z-index:1000;
  background:#450a0a; border-bottom:2px solid #dc2626;
  padding:12px 16px; display:flex; align-items:center; gap:12px;
  font-family:-apple-system,sans-serif; animation:slideDown .25s ease;
}
@keyframes slideDown { from{transform:translateY(-100%)} to{transform:translateY(0)} }
#alert-banner.hidden { display:none; }
#alert-banner .icon { font-size:1.8rem; flex-shrink:0; }
#alert-banner strong { display:block; color:#fca5a5; font-size:.95rem; line-height:1.3; }
#alert-banner small { color:#f87171; font-size:.78rem; }
#alert-banner .close {
  margin-left:auto; flex-shrink:0; color:#f87171; font-size:1.4rem;
  width:44px; height:44px; display:flex; align-items:center;
  justify-content:center; cursor:pointer; border-radius:8px;
}

#map {
  position:fixed; top:57px; bottom:120px; left:0; right:0;
  transition:top .2s,bottom .2s;
}
#map.with-alert { top:113px; }
```

with:

```css
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.8)} }

/* ── Tabs ───────────────────────────────────────────────────────────────── */

#tabbar {
  position:fixed; top:57px; left:0; right:0; z-index:1000;
  display:flex; background:rgba(10,18,28,.96); border-bottom:1px solid #1e3a5f;
  backdrop-filter:blur(8px);
}
.tab-btn {
  flex:1; padding:11px 0; text-align:center; background:none; border:none;
  border-bottom:2px solid transparent;
  font-family:-apple-system,sans-serif; font-size:.78rem; font-weight:700;
  color:#64748b; letter-spacing:.02em; cursor:pointer;
}
.tab-btn.active { color:#93c5fd; border-bottom-color:#3b82f6; }

.tab-panel { display:none; }
.tab-panel.active { display:block; }

#tab-traffic {
  position:fixed; top:101px; bottom:0; left:0; right:0;
  overflow-y:auto; background:#0f1923;
}
.traffic-scroll { padding:16px 0 32px; }

#alert-banner {
  position:fixed; top:101px; left:0; right:0; z-index:1000;
  background:#450a0a; border-bottom:2px solid #dc2626;
  padding:12px 16px; display:flex; align-items:center; gap:12px;
  font-family:-apple-system,sans-serif; animation:slideDown .25s ease;
}
@keyframes slideDown { from{transform:translateY(-100%)} to{transform:translateY(0)} }
#alert-banner.hidden { display:none; }
#alert-banner .icon { font-size:1.8rem; flex-shrink:0; }
#alert-banner strong { display:block; color:#fca5a5; font-size:.95rem; line-height:1.3; }
#alert-banner small { color:#f87171; font-size:.78rem; }
#alert-banner .close {
  margin-left:auto; flex-shrink:0; color:#f87171; font-size:1.4rem;
  width:44px; height:44px; display:flex; align-items:center;
  justify-content:center; cursor:pointer; border-radius:8px;
}

#map {
  position:fixed; top:101px; bottom:120px; left:0; right:0;
  transition:top .2s,bottom .2s;
}
#map.with-alert { top:157px; }
```

- [ ] **Step 2: Restructure the body HTML**

Replace (around line 278-344, everything from `<div id="topbar">` through the closing `</div>` of `#sheet`):

```html
<div id="topbar">
  <h1>Barge & River Tracker</h1>
  <div class="status-pill">
    <div class="live-dot"></div>
    <span id="vessel-count">Connecting…</span>
  </div>
</div>

<div id="alert-banner" class="hidden">
  <div class="icon">🚨</div>
  <div>
    <strong id="alert-name"></strong>
    <small id="alert-detail"></small>
  </div>
  <div class="close" onclick="dismissAlert()">✕</div>
</div>

<div id="map"></div>

<div id="sheet">
  <div class="sheet-handle"></div>

  <!-- River conditions -->
  <div id="river-panel">
    <div class="river-header">
      <span class="sheet-label">River conditions</span>
      <span id="river-updated">Loading…</span>
    </div>

    <div class="river-stats">
      <div class="river-stat">
        <div class="river-stat-label">Stage</div>
        <div class="river-stat-value" id="river-stage">—</div>
        <div class="river-stat-unit">ft · Parkersburg</div>
      </div>

      <div class="river-condition" id="river-condition">
        <span id="river-condition-dot"></span>
        <span id="river-condition-text">Loading river data…</span>
      </div>
    </div>
  </div>

  <!-- Approach -->
  <div id="approach-header" onclick="toggleApproachPanel()">
    <span class="sheet-label">Approaching</span>
    <span id="approach-badge" class="approach-badge hidden">0</span>
    <span class="approach-chevron">▾</span>
  </div>

  <div id="approach-body">
    <div class="approach-group-label">↑ From Belleville</div>
    <div class="vessel-scroll" id="approach-list-belleville">
      <div class="empty-state">None</div>
    </div>

    <div class="approach-group-label">↓ From Willow Island</div>
    <div class="vessel-scroll" id="approach-list-willow">
      <div class="empty-state">None</div>
    </div>
  </div>

  <div class="sheet-label">Nearby vessels</div>
  <div class="vessel-scroll" id="vessel-list">
    <div class="empty-state">Connecting to AIS…</div>
  </div>
</div>
```

with:

```html
<div id="topbar">
  <h1>Barge & River Tracker</h1>
  <div class="status-pill">
    <div class="live-dot"></div>
    <span id="vessel-count">Connecting…</span>
  </div>
</div>

<div id="tabbar">
  <button class="tab-btn active" data-tab="map" onclick="switchTab('map')">Map &amp; Vessels</button>
  <button class="tab-btn" data-tab="traffic" onclick="switchTab('traffic')">Traffic Log</button>
</div>

<div id="tab-map" class="tab-panel active">
  <div id="alert-banner" class="hidden">
    <div class="icon">🚨</div>
    <div>
      <strong id="alert-name"></strong>
      <small id="alert-detail"></small>
    </div>
    <div class="close" onclick="dismissAlert()">✕</div>
  </div>

  <div id="map"></div>

  <div id="sheet">
    <div class="sheet-handle"></div>

    <!-- Approach -->
    <div id="approach-header" onclick="toggleApproachPanel()">
      <span class="sheet-label">Approaching</span>
      <span id="approach-badge" class="approach-badge hidden">0</span>
      <span class="approach-chevron">▾</span>
    </div>

    <div id="approach-body">
      <div class="approach-group-label">↑ From Belleville</div>
      <div class="vessel-scroll" id="approach-list-belleville">
        <div class="empty-state">None</div>
      </div>

      <div class="approach-group-label">↓ From Willow Island</div>
      <div class="vessel-scroll" id="approach-list-willow">
        <div class="empty-state">None</div>
      </div>
    </div>

    <div class="sheet-label">Nearby vessels</div>
    <div class="vessel-scroll" id="vessel-list">
      <div class="empty-state">Connecting to AIS…</div>
    </div>
  </div>
</div>

<div id="tab-traffic" class="tab-panel">
  <div class="traffic-scroll">
    <!-- River conditions -->
    <div id="river-panel">
      <div class="river-header">
        <span class="sheet-label">River conditions</span>
        <span id="river-updated">Loading…</span>
      </div>

      <div class="river-stats">
        <div class="river-stat">
          <div class="river-stat-label">Stage</div>
          <div class="river-stat-value" id="river-stage">—</div>
          <div class="river-stat-unit">ft · Parkersburg</div>
        </div>

        <div class="river-condition" id="river-condition">
          <span id="river-condition-dot"></span>
          <span id="river-condition-text">Loading river data…</span>
        </div>
      </div>
    </div>

    <!-- Lock traffic -->
    <div id="lock-panel">
      <div class="river-header">
        <span class="sheet-label">Lock traffic</span>
        <span id="lock-updated">Loading…</span>
      </div>

      <div class="lock-lock">
        <div class="lock-lock-name">Belleville Locks and Dam</div>
        <div class="lockage-list" id="lock-list-belleville">
          <div class="empty-state">Loading…</div>
        </div>
      </div>

      <div class="lock-lock">
        <div class="lock-lock-name">Willow Island Locks and Dam</div>
        <div class="lockage-list" id="lock-list-willowIsland">
          <div class="empty-state">Loading…</div>
        </div>
      </div>
    </div>
  </div>
</div>
```

Note the danger-zone alert banner now lives inside `#tab-map` rather than as a page-level element — it's positioned relative to the map/danger-zone, so it only makes sense to show while that tab is active (when `#tab-map` is hidden, its `display:none` also hides the fixed-positioned `#alert-banner`/`#map`/`#sheet` inside it, since a `display:none` ancestor removes fixed descendants from rendering too).

- [ ] **Step 3: Add CSS for the new Lock Traffic panel**

Add this new CSS block right after the existing "River conditions" CSS block (after the `#river-condition.error #river-condition-dot { background:#64748b; }` rule, before the "Approach panel" comment block):

```css
/* ── Lock traffic ───────────────────────────────────────────────────────── */

#lock-panel {
  padding:16px 16px 11px;
}

.lock-lock { margin-bottom:14px; }
.lock-lock:last-child { margin-bottom:0; }

.lock-lock-name {
  font-size:.72rem; font-weight:700; color:#93c5fd;
  margin-bottom:6px;
}

.lockage-list {
  display:flex; flex-direction:column; gap:6px;
}

.lockage-row {
  background:#131f2e; border:1px solid #26384d; border-radius:9px;
  padding:8px 10px; display:flex; justify-content:space-between;
  align-items:center; gap:10px; font-size:.72rem;
}

.lockage-row .lockage-vessel { color:#e2e8f0; font-weight:600; }
.lockage-row .lockage-up { color:#f59e0b; }
.lockage-row .lockage-down { color:#2563eb; }
.lockage-row .lockage-detail { color:#64748b; flex-shrink:0; }
```

(Direction colors match the existing barge-marker convention already used on the map — amber for upriver, blue for downriver — see `bargeIcon()`'s `cogToDirection(vessel.cog) === 'Upriver' ? '#f59e0b' : '#2563eb'`.)

- [ ] **Step 4: Sanity-check the HTML is well-formed**

Run: `python3 -c "import re; content = open('index.html').read(); assert content.count('<div') == content.count('</div>'), 'mismatched div tags'; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: restructure index.html into Map & Vessels / Traffic Log tabs"
```

---

### Task 6: Tab-switching and Lock Traffic JS

**Files:**
- Modify: `index.html` (inside `<script>`: add a TABS section and a LOCK TRAFFIC section, both after the existing RIVER CONDITIONS section; add one line to the `window.*` exports)

- [ ] **Step 1: Add the LOCK TRAFFIC section**

Insert this new section immediately after the existing RIVER CONDITIONS section (after the line `setInterval(updateRiverConditions, 10 * 60 * 1000);` and before the `HELPERS` section comment):

```js
/* ==========================================================================
   LOCK TRAFFIC
   ========================================================================== */

const LOCK_TRAFFIC_URL = './lock-traffic.json';
const LOCK_KEYS = ['belleville', 'willowIsland'];

function timeAgo(date) {
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';

  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderLockPanel(key, lockData) {
  const list = document.getElementById(`lock-list-${key}`);
  const lockages = lockData?.recentLockages || [];

  if (lockages.length === 0) {
    list.innerHTML = '<div class="empty-state">No recent lockages</div>';
    return;
  }

  list.innerHTML = lockages.map(l => {
    const dirClass = l.direction === 'U' ? 'lockage-up' : 'lockage-down';
    const dirIcon = l.direction === 'U' ? '↑' : '↓';
    const when = timeAgo(new Date(l.endOfLockage));

    return `
      <div class="lockage-row">
        <span class="lockage-vessel"><span class="${dirClass}">${dirIcon}</span> ${l.vesselName}</span>
        <span class="lockage-detail">${l.numBarges} barges · ${when}</span>
      </div>`;
  }).join('');
}

async function updateLockTraffic() {
  try {
    const response = await fetch(
      LOCK_TRAFFIC_URL + '?t=' + Date.now(),
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(`lock-traffic.json HTTP ${response.status}`);
    }

    const data = await response.json();

    for (const key of LOCK_KEYS) {
      renderLockPanel(key, data.locks?.[key]);
    }

    const updated = data.updated
      ? new Date(data.updated)
      : null;

    document.getElementById('lock-updated').textContent =
      updated && !isNaN(updated)
        ? 'Updated ' + updated.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit'
          })
        : 'No timestamp';

    console.log('Lock traffic data:', data);

  } catch (err) {
    console.error('Lock traffic data error:', err);

    document.getElementById('lock-updated').textContent = 'Fetch failed';

    for (const key of LOCK_KEYS) {
      document.getElementById(`lock-list-${key}`).innerHTML =
        '<div class="empty-state">Lock traffic unavailable</div>';
    }
  }
}

/* Initial lock-traffic load + refresh every 10 minutes */
updateLockTraffic();
setInterval(updateLockTraffic, 10 * 60 * 1000);
```

- [ ] **Step 2: Add the TABS section**

Insert this new section immediately after the LOCK TRAFFIC section added in Step 1 (still before `HELPERS`):

```js
/* ==========================================================================
   TABS
   ========================================================================== */

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  document.getElementById('tab-map').classList.toggle('active', tab === 'map');
  document.getElementById('tab-traffic').classList.toggle('active', tab === 'traffic');

  if (tab === 'map') {
    // Leaflet caches container size; switching back from a display:none
    // ancestor leaves stale/gray tiles until it's told to remeasure.
    map.invalidateSize();
    syncMapOffset();
  }
}
```

- [ ] **Step 3: Export `switchTab` for the inline `onclick` handlers**

Replace (near the end of the VESSEL STATE section):

```js
window.focusVessel = focusVessel;
window.dismissAlert = dismissAlert;
window.toggleApproachPanel = toggleApproachPanel;
```

with:

```js
window.focusVessel = focusVessel;
window.dismissAlert = dismissAlert;
window.toggleApproachPanel = toggleApproachPanel;
window.switchTab = switchTab;
```

- [ ] **Step 4: Check the inline script still parses correctly**

Run:
```bash
python3 -c "
import re
content = open('index.html').read()
script = re.search(r'<script>(.*)</script>', content, re.S).group(1)
open('/tmp/index-check.js', 'w').write(script)
"
node --check /tmp/index-check.js
```
Expected: no output (success)

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add tab switching and lock traffic rendering to index.html"
```

---

### Task 7: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Set up a local test server with fake data files**

```bash
mkdir -p /tmp/lock-traffic-test-server
cp index.html /tmp/lock-traffic-test-server/index.html

cat > /tmp/lock-traffic-test-server/river.json << 'EOF'
{
  "stageFt": 24.67,
  "trend": "falling",
  "floodCategory": "no_flooding",
  "updated": "2026-08-26T18:00:00Z"
}
EOF

cat > /tmp/lock-traffic-test-server/lock-traffic.json << 'EOF'
{
  "updated": "2026-08-26T18:05:00.000Z",
  "locks": {
    "belleville": {
      "name": "Belleville Locks and Dam",
      "recentLockages": [
        { "vesselName": "GLENN A HENDON", "direction": "U", "numBarges": 11, "endOfLockage": "2026-08-26T16:48:00-05:00", "mmsi": 367375080 },
        { "vesselName": "DAN ELDER", "direction": "U", "numBarges": 15, "endOfLockage": "2026-08-26T14:02:00-05:00", "mmsi": 367503540 }
      ]
    },
    "willowIsland": {
      "name": "Willow Island Locks and Dam",
      "recentLockages": []
    }
  }
}
EOF
```

- [ ] **Step 2: Serve it**

Run:
```bash
cd /tmp/lock-traffic-test-server && python3 -m http.server 8899
```

- [ ] **Step 3: Verify the "Map & Vessels" tab is unchanged**

Open `http://localhost:8899/index.html`. Confirm:
- "Map & Vessels" is active by default (highlighted tab, blue underline).
- The map, danger-zone circle, "Approaching" section, and "Nearby vessels" list all render exactly as before — no River Conditions panel visible in this tab.
- No visible gap or overlap between the tab bar and the map below it. The `top:101px`/`top:157px` offsets in Task 5 assume a ~44px-tall tab bar; if there's a gap or the map is cut off under the tab bar, open browser devtools, check `#tabbar`'s computed height, and adjust both offset values in `index.html` (`#alert-banner`, `#map`, `#map.with-alert`, `#tab-traffic`) to `57 + <actual tab bar height>` and `57 + <actual tab bar height> + 56` respectively.
- No console errors.

- [ ] **Step 4: Verify the "Traffic Log" tab**

Click "Traffic Log". Confirm:
- The map disappears entirely (not just visually — it's `display:none`, not underneath).
- The River Conditions panel shows `24.67 ↓` for Stage and a green "NORMAL POOL" banner.
- The Lock Traffic panel shows two rows under "Belleville Locks and Dam" (GLENN A HENDON and DAN ELDER, each with barge count and a relative time ending in "ago" — the exact minutes/hours depend on when you run this, since it's computed from the current time).
- "Willow Island Locks and Dam" shows "No recent lockages".
- The "Updated" timestamp next to "Lock traffic" shows a real clock time (not "Loading…" or "No timestamp").

- [ ] **Step 5: Verify switching back to "Map & Vessels" doesn't break the map**

Click "Map & Vessels" again. Confirm the map tiles render correctly (not gray/blank) and the danger-zone circle and OVRC Launch marker are still in the right place. This confirms `map.invalidateSize()` is working.

- [ ] **Step 6: Verify the Lock Traffic error path**

Rename `lock-traffic.json` (e.g. `mv lock-traffic.json lock-traffic.json.bak`), refresh the page, click "Traffic Log". Confirm both lock panels show "Lock traffic unavailable" and the "Lock traffic" updated label shows "Fetch failed". Restore the file afterward (`mv lock-traffic.json.bak lock-traffic.json`) if you want to re-verify Step 4.

- [ ] **Step 7: Clean up**

Stop the `http.server` process (Ctrl+C) and remove the test directory: `rm -rf /tmp/lock-traffic-test-server`

---

### Task 8: Push and confirm the live workflow

**Files:** none (deployment/observation only)

- [ ] **Step 1: Push all commits from Tasks 1–6**

```bash
git push origin main
```

- [ ] **Step 2: Trigger the new workflow manually the first time**

On GitHub, go to the repo's Actions tab → "Update lock traffic" → "Run workflow" (don't wait for the next `:05`/`:35` scheduled run).

- [ ] **Step 3: Confirm `lock-traffic.json` landed on GitHub**

Run: `curl -s https://raw.githubusercontent.com/jahart/barge-tracker/main/lock-traffic.json`
Expected: real JSON matching the shape from Task 3, with a fresh `updated` timestamp.

- [ ] **Step 4: Confirm the live page shows it**

Open `https://jahart.github.io/barge-tracker/`, click "Traffic Log", and confirm both the River Conditions and Lock Traffic panels show real data (not "unavailable" states).

---

## Self-Review Notes

- **Spec coverage:** data source + endpoint + lock codes (Task 3), `timezone`-is-fixed-UTC-5 handling (Task 2), `lock-traffic.json` shape incl. 5-entry cap and dropped fields (Task 2 & 3), shared `fetch-with-retry` extraction (Task 1), standalone offset-cron workflow (Task 4), tabbed UI with map hidden (not shrunk) on Traffic Log (Task 5), River Conditions panel relocation (Task 5), Lock Traffic panel rendering incl. relative time and error state (Task 6), Leaflet `invalidateSize()` on tab switch back (Task 6, verified in Task 7 Step 5), AIS status pill staying visible regardless of tab (Task 5 — it's part of `#topbar`, which is untouched and outside both `.tab-panel`s).
- **Type consistency:** `shapeLockQueue(rawArray)` returns `{ recentLockages: [...] }` (Task 2); `update-lock-traffic.mjs` (Task 3) spreads that directly into each lock's object alongside `name`, matching the spec's `lock-traffic.json` shape exactly. Field names (`vesselName`, `direction`, `numBarges`, `endOfLockage`, `mmsi`) are identical across the shaping function (Task 2), the written JSON (Task 3), and the client-side reader `renderLockPanel` (Task 6). Element IDs `lock-list-belleville`/`lock-list-willowIsland` (Task 5 HTML) match the `LOCK_KEYS` array and template-literal lookups in `renderLockPanel`/`updateLockTraffic` (Task 6) exactly, including the `willowIsland` camelCase spelling used consistently in both the JSON schema and the DOM.
- **No placeholders:** none found. The one inherently-approximate value (tab-bar height, estimated at 44px for the `top:101px`/`top:157px` offsets in Task 5) is flagged with an explicit verification step (Task 7 Step 3/4 — visually confirm no gap/overlap) rather than asserted as exact, since real rendered height can only be confirmed in a browser.
