# Lock-Approach Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show barges approaching OVRC Launch from Belleville (downriver) and Willow Island (upriver) locks, well before they reach the existing 3-mile danger zone, in both the server (SSE) and standalone (static HTML) versions of the app.

**Architecture:** Widen the AISStream bounding box (server-side constant in `server.js`; inline constant in `standalone/index.html`) to cover both locks. Client-side, classify each tracked vessel as "nearby" (existing behavior, unchanged), "approaching from Belleville," "approaching from Willow Island," or unclassified (still gets a map marker, no list entry) using latitude-relative-to-OVRC + existing course-bucketing. Render the approach groups in a new collapsible panel inside the existing bottom sheet.

**Tech Stack:** Plain JS (no build step, no bundler), Leaflet.js, Express + `ws` (server SSE relay), AISStream.io WebSocket. No test framework exists in this repo — verification is done via `node -e` snippets for pure logic and manual browser checks for UI/rendering (see Task 1 and Task 6).

**Reference:** Spec at `docs/superpowers/specs/2026-07-16-lock-approach-tracking-design.md`.

---

### Task 1: Verify the classification geometry before wiring it into the UI

**Files:** none (throwaway verification script in `/tmp`, deleted at the end of this task)

The classification logic decides whether a vessel counts as "approaching from Belleville" or "approaching from Willow Island." Verify the math against known coordinates before pasting it into two separate HTML files, so any bug is caught once instead of twice.

- [ ] **Step 1: Write the verification script**

Create `/tmp/verify-approach.js`:

```js
const OVRC = [39.2833, -81.5631];
const ZONE_CENTER = [39.2851, -81.5631];
const NEARBY_RADIUS_M = 12875; // ~8 miles

function cogToDirection(cog) {
  const c = ((cog % 360) + 360) % 360;
  if (c >= 315 || c < 45) return 'Upriver';
  if (c >= 135 && c < 225) return 'Downriver';
  return 'Crossing';
}

function distanceM(a, b) {
  const R = 6371000;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function approachSource(vessel) {
  const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
  if (dist <= NEARBY_RADIUS_M) return null;
  const dir = cogToDirection(vessel.cog);
  if (vessel.lat < OVRC[0] && dir === 'Upriver') return 'belleville';
  if (vessel.lat > OVRC[0] && dir === 'Downriver') return 'willow-island';
  return null;
}

const cases = [
  { name: 'south of OVRC, heading upriver -> belleville',      v: { lat: 39.18, lon: -81.70, cog: 0   }, expect: 'belleville' },
  { name: 'north of OVRC, heading downriver -> willow-island', v: { lat: 39.38, lon: -81.40, cog: 180 }, expect: 'willow-island' },
  { name: 'close to OVRC -> null (handled by Nearby list)',    v: { lat: 39.29, lon: -81.56, cog: 0   }, expect: null },
  { name: 'south of OVRC but heading downriver (away) -> null', v: { lat: 39.18, lon: -81.70, cog: 180 }, expect: null },
  { name: 'north of OVRC but heading upriver (away) -> null',   v: { lat: 39.38, lon: -81.40, cog: 0   }, expect: null },
];

let failed = 0;
for (const c of cases) {
  const got = approachSource(c.v);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name} (got ${got}, expected ${c.expect})`);
}
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run it**

Run: `node /tmp/verify-approach.js`
Expected: five `PASS` lines, exit code 0.

- [ ] **Step 3: Delete the scratch file**

Run: `rm /tmp/verify-approach.js`

This confirms the exact `approachSource` function body (copied verbatim into Tasks 3 and 5 below) behaves correctly before it's embedded in the app.

---

### Task 2: Widen the AISStream bounding box (server version)

**Files:**
- Modify: `server.js:43`

- [ ] **Step 1: Change the bounding box constant**

In `server.js`, replace:

```js
const BOUNDING_BOX         = [[39.24, -81.60], [39.35, -81.50]];
```

with:

```js
const BOUNDING_BOX         = [[39.05, -81.80], [39.42, -81.25]];
```

This is the only server.js change — it covers both Belleville (39.1193, -81.7425) and Willow Island (39.3592, -81.3192) with margin. Everything else (SSE relay, vessel store, stale pruning) is unchanged; the client decides how to group/display what it receives.

- [ ] **Step 2: Start the server and confirm it connects**

Run: `node server.js`
Expected console output: `Barge Tracker running on http://localhost:3000` followed by `AISStream connected` (assuming `AISSTREAM_API_KEY` is set in `.env`; if not set, you'll see the existing "running without live data" warning, which is fine for this step — we're only confirming the process doesn't crash on the new constant).

Stop the server with Ctrl+C once confirmed.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: widen AIS bounding box to cover Belleville and Willow Island locks"
```

---

### Task 3: Add approach classification and panel rendering (`public/app.js`)

**Files:**
- Modify: `public/app.js:1-7` (constants)
- Modify: `public/app.js:27-32` (after `etaMinutes`, before `// ── Map setup`)
- Modify: `public/app.js:142-168` (`renderList`)
- Modify: `public/app.js:203-204` (window exposure)
- Modify: `public/app.js` end of file (call `syncMapOffset()` once on load)

- [ ] **Step 1: Add the new constants**

In `public/app.js`, after line 6 (`const MAP_ZOOM = 13;`) and before the blank line 7, add:

```js
const BELLEVILLE      = [39.1193, -81.7425]; // Belleville Locks and Dam — river mile 203.9, south of OVRC
const WILLOW_ISLAND   = [39.3592, -81.3192]; // Willow Island Locks and Dam — river mile 161.7, north of OVRC
const NEARBY_RADIUS_M = 12875;               // ~8 miles — matches the old bounding box's rough coverage
```

- [ ] **Step 2: Add the classification function**

After the `etaMinutes` function (ends at line 32) and before the `// ── Map setup ──` comment (line 34), add:

```js
// Classifies a vessel outside the Nearby radius as approaching from a lock, or null
function approachSource(vessel) {
  const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
  if (dist <= NEARBY_RADIUS_M) return null;
  const dir = cogToDirection(vessel.cog);
  if (vessel.lat < OVRC[0] && dir === 'Upriver') return 'belleville';
  if (vessel.lat > OVRC[0] && dir === 'Downriver') return 'willow-island';
  return null;
}
```

- [ ] **Step 3: Filter `renderList` to the Nearby radius and delegate to the new approach panel**

Replace the entire `renderList` function (current lines 142-168):

```js
function renderList() {
  const list = document.getElementById('vessel-list');
  const count = vesselData.size;

  document.getElementById('vessel-count').textContent =
    count === 1 ? '1 vessel' : `${count} vessels`;

  if (count === 0) {
    list.innerHTML = '<div class="empty-state">No vessels in range</div>';
    return;
  }

  const sorted = [...vesselData.values()].sort((a, b) => {
    const da = distanceM(ZONE_CENTER, [a.lat, a.lon]);
    const db = distanceM(ZONE_CENTER, [b.lat, b.lon]);
    const aIn = da <= DANGER_RADIUS_M;
    const bIn = db <= DANGER_RADIUS_M;
    if (aIn !== bIn) return aIn ? -1 : 1;
    return da - db;
  });

  list.innerHTML = sorted.map(v => {
    const dist = distanceM(ZONE_CENTER, [v.lat, v.lon]);
    const inZone = dist <= DANGER_RADIUS_M;
    return `<div class="vessel-chip ${inZone ? 'danger' : ''}" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`;
  }).join('');
}
```

with:

```js
function renderList() {
  const list = document.getElementById('vessel-list');
  const nearby = [...vesselData.values()].filter(
    v => distanceM(ZONE_CENTER, [v.lat, v.lon]) <= NEARBY_RADIUS_M
  );

  document.getElementById('vessel-count').textContent =
    nearby.length === 1 ? '1 vessel' : `${nearby.length} vessels`;

  if (nearby.length === 0) {
    list.innerHTML = '<div class="empty-state">No vessels in range</div>';
  } else {
    const sorted = nearby.sort((a, b) => {
      const da = distanceM(ZONE_CENTER, [a.lat, a.lon]);
      const db = distanceM(ZONE_CENTER, [b.lat, b.lon]);
      const aIn = da <= DANGER_RADIUS_M;
      const bIn = db <= DANGER_RADIUS_M;
      if (aIn !== bIn) return aIn ? -1 : 1;
      return da - db;
    });

    list.innerHTML = sorted.map(v => {
      const inZone = distanceM(ZONE_CENTER, [v.lat, v.lon]) <= DANGER_RADIUS_M;
      return `<div class="vessel-chip ${inZone ? 'danger' : ''}" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`;
    }).join('');
  }

  renderApproachPanel();
}

function renderApproachPanel() {
  const belleville = [];
  const willow = [];
  for (const v of vesselData.values()) {
    const src = approachSource(v);
    if (src === 'belleville') belleville.push(v);
    else if (src === 'willow-island') willow.push(v);
  }

  const byEta = (a, b) => {
    const ea = etaMinutes(distanceM(ZONE_CENTER, [a.lat, a.lon]), a.sog);
    const eb = etaMinutes(distanceM(ZONE_CENTER, [b.lat, b.lon]), b.sog);
    return (ea ?? Infinity) - (eb ?? Infinity);
  };
  belleville.sort(byEta);
  willow.sort(byEta);

  const badge = document.getElementById('approach-badge');
  const total = belleville.length + willow.length;
  badge.textContent = total;
  badge.classList.toggle('hidden', total === 0);

  renderApproachGroup('approach-list-belleville', belleville);
  renderApproachGroup('approach-list-willow', willow);

  syncMapOffset();
}

function renderApproachGroup(elementId, vessels) {
  const el = document.getElementById(elementId);
  if (vessels.length === 0) {
    el.innerHTML = '<div class="empty-state">None</div>';
    return;
  }
  el.innerHTML = vessels.map(v =>
    `<div class="vessel-chip" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`
  ).join('');
}

function toggleApproachPanel() {
  document.getElementById('approach-body').classList.toggle('expanded');
  document.querySelector('.approach-chevron').classList.toggle('expanded');
  syncMapOffset();
}

function syncMapOffset() {
  const sheet = document.getElementById('sheet');
  document.getElementById('map').style.bottom = sheet.getBoundingClientRect().height + 'px';
}
```

- [ ] **Step 4: Expose `toggleApproachPanel` to the global scope**

Replace (current lines 203-204):

```js
window.focusVessel = focusVessel;
window.dismissAlert = dismissAlert;
```

with:

```js
window.focusVessel = focusVessel;
window.dismissAlert = dismissAlert;
window.toggleApproachPanel = toggleApproachPanel;
```

- [ ] **Step 5: Sync the map offset once on initial load**

At the end of `public/app.js`, the last line is `connectSSE();`. Add a call right after it:

```js
connectSSE();
syncMapOffset();
```

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat: classify and render approaching-from-lock vessels"
```

---

### Task 4: Add the Approach panel markup and CSS (`public/index.html`)

**Files:**
- Modify: `public/index.html:54-68` (CSS: `#map`, `#sheet`, new approach classes)
- Modify: `public/index.html:129-135` (HTML: sheet contents)

- [ ] **Step 1: Update `#map`/`#sheet` CSS and add new approach classes**

Replace:

```css
#map {
  position: fixed; top: 57px; bottom: 120px; left: 0; right: 0;
  transition: top 0.2s;
}
#map.with-alert { top: 113px; }

#sheet {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 1000;
  background: rgba(10,18,28,0.97); border-top: 1px solid #1e3a5f;
  border-radius: 18px 18px 0 0; backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px); height: 120px;
  font-family: -apple-system, sans-serif;
}
.sheet-handle { width: 36px; height: 4px; background: #334155; border-radius: 2px; margin: 10px auto 8px; }
.sheet-label { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #475569; padding: 0 16px; margin-bottom: 8px; }
```

with:

```css
#map {
  position: fixed; top: 57px; bottom: 120px; left: 0; right: 0;
  transition: top 0.2s, bottom 0.2s;
}
#map.with-alert { top: 113px; }

#sheet {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 1000;
  background: rgba(10,18,28,0.97); border-top: 1px solid #1e3a5f;
  border-radius: 18px 18px 0 0; backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-family: -apple-system, sans-serif;
}
.sheet-handle { width: 36px; height: 4px; background: #334155; border-radius: 2px; margin: 10px auto 8px; }
.sheet-label { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #475569; padding: 0 16px; margin-bottom: 8px; }

#approach-header {
  display: flex; align-items: center; gap: 8px;
  padding: 0 16px 8px; cursor: pointer;
}
#approach-header .sheet-label { margin-bottom: 0; }
.approach-badge {
  background: #1e3a5f; color: #93c5fd; font-size: 0.68rem; font-weight: 700;
  border-radius: 10px; padding: 1px 7px;
}
.approach-badge.hidden { display: none; }
.approach-chevron {
  margin-left: auto; color: #475569; font-size: 0.8rem;
  transition: transform 0.2s;
}
.approach-chevron.expanded { transform: rotate(180deg); }
#approach-body {
  max-height: 0; overflow: hidden; transition: max-height 0.2s ease;
}
#approach-body.expanded { max-height: 220px; }
.approach-group-label {
  font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: #64748b; padding: 6px 16px 4px;
}
```

- [ ] **Step 2: Update the sheet markup**

Replace:

```html
<div id="sheet">
  <div class="sheet-handle"></div>
  <div class="sheet-label">Nearby vessels</div>
  <div class="vessel-scroll" id="vessel-list">
    <div class="empty-state">Waiting for AIS data…</div>
  </div>
</div>
```

with:

```html
<div id="sheet">
  <div class="sheet-handle"></div>

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
    <div class="empty-state">Waiting for AIS data…</div>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add collapsible Approaching panel to the sheet UI"
```

---

### Task 5: Mirror all changes into the standalone version (`standalone/index.html`)

**Files:**
- Modify: `standalone/index.html:49-68` (CSS — same additions as Task 4, Step 1)
- Modify: `standalone/index.html:107-113` (HTML — same markup as Task 4, Step 2)
- Modify: `standalone/index.html:119-126` (JS constants + `BOUNDING_BOX`)
- Modify: `standalone/index.html:129-149` (JS — after `etaMinutes`, add `approachSource`)
- Modify: `standalone/index.html:250-266` (JS — `renderList` + new render functions)
- Modify: `standalone/index.html:297-298` (JS — window exposure)
- Modify: `standalone/index.html` end of file (sync map offset on load)

This file is a single self-contained page (no `app.js` import), so every change from Tasks 2-4 is re-applied here verbatim, in the same file.

- [ ] **Step 1: CSS — apply the exact same `#map`/`#sheet` replacement and new classes from Task 4, Step 1**

Same before/after blocks as Task 4 Step 1, applied to `standalone/index.html`'s `<style>` block (lines 49-68).

- [ ] **Step 2: HTML — apply the exact same sheet markup replacement from Task 4, Step 2**

Same before/after blocks as Task 4 Step 2, applied to `standalone/index.html`'s `<body>` (lines 107-113).

- [ ] **Step 3: JS constants — widen the bounding box and add the lock/nearby constants**

Replace:

```js
const OVRC            = [39.2833, -81.5631];  // Memorial Bridge, Parkersburg WV
const ZONE_CENTER     = [39.2851, -81.5631];  // Danger zone center — 1/8 mi north of launch
const DANGER_RADIUS_M = 4828;                 // 3 miles
const MAP_CENTER      = [39.2900, -81.5631];
const MAP_ZOOM        = 13;
const BOUNDING_BOX    = [[39.24, -81.60], [39.35, -81.50]];
const STALE_MS        = 10 * 60 * 1000;
```

with:

```js
const OVRC            = [39.2833, -81.5631];  // Memorial Bridge, Parkersburg WV
const ZONE_CENTER     = [39.2851, -81.5631];  // Danger zone center — 1/8 mi north of launch
const DANGER_RADIUS_M = 4828;                 // 3 miles
const MAP_CENTER      = [39.2900, -81.5631];
const MAP_ZOOM        = 13;
const BOUNDING_BOX    = [[39.05, -81.80], [39.42, -81.25]]; // widened to cover Belleville + Willow Island
const STALE_MS        = 10 * 60 * 1000;
const BELLEVILLE      = [39.1193, -81.7425]; // Belleville Locks and Dam — river mile 203.9, south of OVRC
const WILLOW_ISLAND   = [39.3592, -81.3192]; // Willow Island Locks and Dam — river mile 161.7, north of OVRC
const NEARBY_RADIUS_M = 12875;               // ~8 miles — matches the old bounding box's rough coverage
```

- [ ] **Step 4: JS — add `approachSource` after `etaMinutes`**

After the `etaMinutes` function (currently ends at line 149, right before `// ── Map ──`), add:

```js
// Classifies a vessel outside the Nearby radius as approaching from a lock, or null
function approachSource(vessel) {
  const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
  if (dist <= NEARBY_RADIUS_M) return null;
  const dir = cogToDirection(vessel.cog);
  if (vessel.lat < OVRC[0] && dir === 'Upriver') return 'belleville';
  if (vessel.lat > OVRC[0] && dir === 'Downriver') return 'willow-island';
  return null;
}
```

- [ ] **Step 5: JS — replace `renderList` and add the new render/toggle/sync functions**

Replace (current lines 250-266):

```js
function renderList() {
  const list  = document.getElementById('vessel-list');
  const count = vesselData.size;
  document.getElementById('vessel-count').textContent = count === 1 ? '1 vessel' : `${count} vessels`;
  if (count === 0) { list.innerHTML = '<div class="empty-state">No vessels in range</div>'; return; }
  const sorted = [...vesselData.values()].sort((a, b) => {
    const da = distanceM(ZONE_CENTER, [a.lat, a.lon]);
    const db = distanceM(ZONE_CENTER, [b.lat, b.lon]);
    const aIn = da <= DANGER_RADIUS_M, bIn = db <= DANGER_RADIUS_M;
    if (aIn !== bIn) return aIn ? -1 : 1;
    return da - db;
  });
  list.innerHTML = sorted.map(v => {
    const inZone = distanceM(ZONE_CENTER, [v.lat, v.lon]) <= DANGER_RADIUS_M;
    return `<div class="vessel-chip ${inZone ? 'danger' : ''}" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`;
  }).join('');
}
```

with:

```js
function renderList() {
  const list = document.getElementById('vessel-list');
  const nearby = [...vesselData.values()].filter(
    v => distanceM(ZONE_CENTER, [v.lat, v.lon]) <= NEARBY_RADIUS_M
  );

  document.getElementById('vessel-count').textContent =
    nearby.length === 1 ? '1 vessel' : `${nearby.length} vessels`;

  if (nearby.length === 0) {
    list.innerHTML = '<div class="empty-state">No vessels in range</div>';
  } else {
    const sorted = nearby.sort((a, b) => {
      const da = distanceM(ZONE_CENTER, [a.lat, a.lon]);
      const db = distanceM(ZONE_CENTER, [b.lat, b.lon]);
      const aIn = da <= DANGER_RADIUS_M, bIn = db <= DANGER_RADIUS_M;
      if (aIn !== bIn) return aIn ? -1 : 1;
      return da - db;
    });
    list.innerHTML = sorted.map(v => {
      const inZone = distanceM(ZONE_CENTER, [v.lat, v.lon]) <= DANGER_RADIUS_M;
      return `<div class="vessel-chip ${inZone ? 'danger' : ''}" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`;
    }).join('');
  }

  renderApproachPanel();
}

function renderApproachPanel() {
  const belleville = [];
  const willow = [];
  for (const v of vesselData.values()) {
    const src = approachSource(v);
    if (src === 'belleville') belleville.push(v);
    else if (src === 'willow-island') willow.push(v);
  }

  const byEta = (a, b) => {
    const ea = etaMinutes(distanceM(ZONE_CENTER, [a.lat, a.lon]), a.sog);
    const eb = etaMinutes(distanceM(ZONE_CENTER, [b.lat, b.lon]), b.sog);
    return (ea ?? Infinity) - (eb ?? Infinity);
  };
  belleville.sort(byEta);
  willow.sort(byEta);

  const badge = document.getElementById('approach-badge');
  const total = belleville.length + willow.length;
  badge.textContent = total;
  badge.classList.toggle('hidden', total === 0);

  renderApproachGroup('approach-list-belleville', belleville);
  renderApproachGroup('approach-list-willow', willow);

  syncMapOffset();
}

function renderApproachGroup(elementId, vessels) {
  const el = document.getElementById(elementId);
  if (vessels.length === 0) {
    el.innerHTML = '<div class="empty-state">None</div>';
    return;
  }
  el.innerHTML = vessels.map(v =>
    `<div class="vessel-chip" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`
  ).join('');
}

function toggleApproachPanel() {
  document.getElementById('approach-body').classList.toggle('expanded');
  document.querySelector('.approach-chevron').classList.toggle('expanded');
  syncMapOffset();
}

function syncMapOffset() {
  const sheet = document.getElementById('sheet');
  document.getElementById('map').style.bottom = sheet.getBoundingClientRect().height + 'px';
}
```

- [ ] **Step 6: JS — expose `toggleApproachPanel`**

Replace:

```js
window.focusVessel  = focusVessel;
window.dismissAlert = dismissAlert;
```

with:

```js
window.focusVessel  = focusVessel;
window.dismissAlert = dismissAlert;
window.toggleApproachPanel = toggleApproachPanel;
```

- [ ] **Step 7: JS — sync map offset once on load**

The file currently ends with:

```js
connectAIS();
```

Change to:

```js
connectAIS();
syncMapOffset();
```

- [ ] **Step 8: Commit**

```bash
git add standalone/index.html
git commit -m "feat: mirror lock-approach tracking into the standalone version"
```

---

### Task 6: Manual verification in the browser (both versions)

**Files:** none (verification only)

Live AIS traffic is unpredictable, so verify the new UI logic by injecting synthetic vessels through the browser console rather than waiting for real barges.

- [ ] **Step 1: Verify the server version**

Run: `node server.js` (with or without `AISSTREAM_API_KEY` set — this test doesn't need live data), then open `http://localhost:3000` in a browser and open its DevTools console.

Paste and run:

```js
applyVessel({ mmsi: '111111111', name: 'Test Belleville',   lat: 39.18, lon: -81.70, sog: 8, cog: 0,   updatedAt: Date.now() });
applyVessel({ mmsi: '222222222', name: 'Test Willow Island', lat: 39.38, lon: -81.40, sog: 6, cog: 180, updatedAt: Date.now() });
applyVessel({ mmsi: '333333333', name: 'Test Nearby',        lat: 39.29, lon: -81.56, sog: 5, cog: 0,   updatedAt: Date.now() });
```

Expected:
- The "Approaching" header now shows a badge with `2`.
- Tapping/clicking the "Approaching" header expands it, showing "Test Belleville" under "↑ From Belleville" and "Test Willow Island" under "↓ From Willow Island."
- "Test Nearby" appears only in the existing "Nearby vessels" strip below, not in the Approaching panel.
- The map now has 3 markers, including two far outside the originally-visible area (zoom/pan out to confirm they're plotted near the expected lock coordinates).

- [ ] **Step 2: Verify the standalone version**

Open `standalone/index.html` directly in a browser (e.g. `open standalone/index.html` on macOS) and repeat Step 1's console commands and expected checks in that page's DevTools console.

- [ ] **Step 3: Confirm collapse/expand doesn't clip the map**

With the Approaching panel expanded (from Step 1), resize the browser window or check that the map's visible area shrinks to make room for the taller sheet, with no dead space or overlap between the map and the sheet. Collapse the panel again and confirm the map grows back.

No commit for this task — it's verification only. If any check fails, fix the relevant file from Tasks 3-5 and re-run this task before proceeding.
