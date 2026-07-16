# Barge Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js app that shows live AIS vessel positions on a Leaflet map of the Ohio River between the OVRC Launch (Parkersburg WV) and Neal Island, with a 2-mile danger zone alert when barges approach the rower's put-in.

**Architecture:** Express serves the static frontend and an SSE endpoint. A persistent WebSocket client connects to AISStream.io, filters PositionReport messages to the Ohio River bounding box, and fans updates out to all connected SSE clients. The browser renders vessels on a Leaflet map and fires alert banners when any vessel enters the 2-mile danger zone.

**Tech Stack:** Node.js 18+, Express 4, `ws` (WebSocket client), Leaflet 1.9 (CDN), Vanilla JS, dotenv, AISStream.io free WebSocket API, ngrok

---

## File Map

| File | Responsibility |
|---|---|
| `package.json` | Dependencies + npm start script |
| `.env` | `AISSTREAM_API_KEY` — never committed |
| `.gitignore` | Exclude `.env`, `node_modules` |
| `server.js` | Express app + AISStream WebSocket client + SSE fan-out |
| `public/index.html` | Full app — Leaflet map, SSE consumer, UI |
| `.claude/launch.json` | Updated to start `node server.js` on port 3000 |
| `README.md` | Setup + ngrok instructions |

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.env`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "barge-tracker",
  "version": "1.0.0",
  "description": "Ohio River barge tracker — OVRC Launch to Neal Island",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "ws": "^8.17.1"
  }
}
```

- [ ] **Step 2: Create `.env`**

```
AISSTREAM_API_KEY=your_key_here
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
.env
```

- [ ] **Step 4: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Commit**

```bash
git init
git add package.json package-lock.json .gitignore
git commit -m "feat: project scaffold"
```

---

## Task 2: Express server with SSE endpoint

**Files:**
- Create: `server.js`

- [ ] **Step 1: Write `server.js` — Express + SSE skeleton**

```js
require('dotenv').config();
const express = require('express');
const { WebSocket } = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory vessel store: MMSI -> vessel object
const vessels = new Map();

// SSE clients
const clients = new Set();

app.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint — browser connects here to receive vessel updates
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current vessel state immediately on connect
  const snapshot = JSON.stringify({ type: 'snapshot', vessels: [...vessels.values()] });
  res.write(`data: ${snapshot}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

// Stub replaced in Task 3
function connectAIS() {}

app.listen(PORT, () => {
  console.log(`Barge Tracker running on http://localhost:${PORT}`);
  connectAIS();
});
```

- [ ] **Step 2: Start server and verify it serves on port 3000**

```bash
node server.js
```

Expected output:
```
Barge Tracker running on http://localhost:3000
```

Open http://localhost:3000/events in a browser — should see an open SSE stream (blank page, no error).

Stop the server (`Ctrl+C`) before next step.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: express server with SSE endpoint"
```

---

## Task 3: AISStream.io WebSocket client

**Files:**
- Modify: `server.js` — add `connectAIS()` function

- [ ] **Step 1: Add `connectAIS()` to `server.js`** (replace the `connectAIS` placeholder stub from Task 2 with this full implementation)

Append this function before `app.listen(...)`:

```js
const BOUNDING_BOX = [[39.24, -81.60], [39.35, -81.50]]; // SW, NE corners of Ohio River stretch
const RECONNECT_DELAY_MS = 5000;

function connectAIS() {
  if (!process.env.AISSTREAM_API_KEY) {
    console.warn('AISSTREAM_API_KEY not set — running without live data');
    return;
  }

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    console.log('AISStream connected');
    ws.send(JSON.stringify({
      APIKey: process.env.AISSTREAM_API_KEY,
      BoundingBoxes: [BOUNDING_BOX],
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.MessageType !== 'PositionReport') return;

      const pos = msg.Message.PositionReport;
      const meta = msg.MetaData || {};

      const vessel = {
        mmsi: String(pos.UserID),
        name: (meta.ShipName || '').trim() || `MMSI ${pos.UserID}`,
        lat: pos.Latitude,
        lon: pos.Longitude,
        sog: pos.Sog,   // speed over ground, knots
        cog: pos.Cog,   // course over ground, degrees true
        updatedAt: Date.now(),
      };

      vessels.set(vessel.mmsi, vessel);
      broadcast({ type: 'update', vessel });
    } catch (err) {
      console.error('AIS parse error:', err.message);
    }
  });

  ws.on('error', (err) => console.error('AISStream error:', err.message));

  ws.on('close', () => {
    console.log(`AISStream disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
    setTimeout(connectAIS, RECONNECT_DELAY_MS);
  });
}
```

- [ ] **Step 2: Test with a real API key**

Sign up at https://aisstream.io (free, no credit card). Copy your API key into `.env`:

```
AISSTREAM_API_KEY=abc123yourkeyhere
```

Start the server:

```bash
node server.js
```

Expected output within 30 seconds (Ohio River may be quiet — give it a few minutes):
```
AISStream connected
```

If no vessels appear within 5 minutes that's normal — the Ohio River is not a busy shipping lane 24/7. The app will display vessels when they broadcast.

- [ ] **Step 3: Verify SSE delivers vessel updates**

While server is running, open http://localhost:3000/events in a browser. When AIS messages arrive you'll see:
```
data: {"type":"update","vessel":{"mmsi":"...","name":"...","lat":39.28,"lon":-81.55,...}}
```

- [ ] **Step 4: Commit**

```bash
git add server.js .env
git commit -m "feat: AISStream WebSocket client with auto-reconnect"
```

> Note: `.env` is in `.gitignore` — `git add .env` will be silently ignored. That's correct.

---

## Task 4: Prune stale vessels

**Files:**
- Modify: `server.js` — add stale-vessel cleanup

Vessels that stop broadcasting (leave the area, anchor without AIS, etc.) should be removed after 10 minutes so the UI doesn't show ghost ships.

- [ ] **Step 1: Add stale-vessel pruner to `server.js`** (add after `connectAIS()` definition, before `app.listen`)

```js
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
  const now = Date.now();
  for (const [mmsi, vessel] of vessels) {
    if (now - vessel.updatedAt > STALE_THRESHOLD_MS) {
      vessels.delete(mmsi);
      broadcast({ type: 'remove', mmsi });
    }
  }
}, 60 * 1000); // check every minute
```

- [ ] **Step 2: Verify format by reading the full `server.js`**

Confirm order is: `require` statements → `app` setup → `/events` route → `broadcast()` → `BOUNDING_BOX` + `connectAIS()` → stale-vessel interval → `app.listen`.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: prune stale vessels after 10 minutes"
```

---

## Task 5: Frontend — map and static UI

**Files:**
- Create: `public/index.html`

This is the full app shell. Vessel data arrives via SSE and is applied in Task 6.

- [ ] **Step 1: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0f1923">
<title>Barge Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; overflow: hidden; background: #0f1923; }

#topbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
  background: rgba(10,18,28,0.96);
  border-bottom: 1px solid #1e3a5f;
  padding: 14px 16px 12px;
  display: flex; align-items: center; justify-content: space-between;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
#topbar h1 { font-size: 1.1rem; font-weight: 700; color: #f8fafc; font-family: -apple-system, sans-serif; }
.status-pill {
  display: flex; align-items: center; gap: 6px;
  background: #0d2d1a; border: 1px solid #166534;
  border-radius: 20px; padding: 4px 10px;
  font-size: 0.72rem; color: #4ade80; font-family: -apple-system, sans-serif;
}
.live-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #4ade80;
  animation: pulse 1.8s ease-in-out infinite;
}
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)} }

#alert-banner {
  position: fixed; top: 57px; left: 0; right: 0; z-index: 1000;
  background: #450a0a; border-bottom: 2px solid #dc2626;
  padding: 12px 16px; display: flex; align-items: center; gap: 12px;
  font-family: -apple-system, sans-serif; animation: slideDown 0.25s ease;
}
@keyframes slideDown { from{transform:translateY(-100%)} to{transform:translateY(0)} }
#alert-banner.hidden { display: none; }
#alert-banner .icon { font-size: 1.8rem; flex-shrink: 0; }
#alert-banner strong { display: block; color: #fca5a5; font-size: 0.95rem; line-height: 1.3; }
#alert-banner small { color: #f87171; font-size: 0.78rem; }
#alert-banner .close {
  margin-left: auto; flex-shrink: 0; color: #f87171; font-size: 1.4rem;
  width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; border-radius: 8px;
}

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
.vessel-scroll { display: flex; gap: 10px; overflow-x: auto; padding: 0 16px 12px; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.vessel-scroll::-webkit-scrollbar { display: none; }

.vessel-chip {
  background: #131f2e; border: 1.5px solid #2d4057; border-radius: 12px;
  padding: 10px 14px; min-width: 155px; flex-shrink: 0; cursor: pointer;
}
.vessel-chip:active { opacity: 0.7; }
.vessel-chip.danger { border-color: #dc2626; background: #1f0909; }
.vessel-chip .vname { font-size: 0.85rem; font-weight: 700; color: #f1f5f9; }
.vessel-chip .vdetail { font-size: 0.72rem; color: #64748b; margin-top: 3px; }
.vessel-chip .veta { font-size: 0.72rem; color: #fbbf24; margin-top: 3px; font-weight: 600; }

.empty-state {
  padding: 0 16px; font-size: 0.75rem; color: #334155;
  display: flex; align-items: center; height: 56px;
}

/* Leaflet overrides */
.leaflet-popup-content-wrapper {
  background: #131f2e !important; border: 1.5px solid #3b82f6 !important;
  border-radius: 12px !important; box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important;
  color: #e2e8f0 !important;
}
.leaflet-popup-tip { background: #131f2e !important; }
.leaflet-popup-content { margin: 12px 16px !important; font-family: -apple-system, sans-serif !important; min-width: 180px; }
.popup-name { font-size: 1rem; font-weight: 700; color: #f8fafc; margin-bottom: 8px; }
.popup-row { font-size: 0.8rem; color: #64748b; margin: 4px 0; }
.popup-row span { color: #e2e8f0; font-weight: 500; }
.popup-eta { margin-top: 10px; background: #450a0a; border: 1px solid #dc2626; border-radius: 7px; padding: 7px 10px; font-size: 0.78rem; color: #fca5a5; font-weight: 600; }
.leaflet-control-zoom { border: 1px solid #2d4057 !important; border-radius: 10px !important; overflow: hidden; }
.leaflet-control-zoom a { background: #131f2e !important; color: #94a3b8 !important; border-color: #2d4057 !important; width: 40px !important; height: 40px !important; line-height: 40px !important; font-size: 1.2rem !important; }
.leaflet-control-zoom a:hover { background: #1e2d3d !important; }
.leaflet-control-attribution { font-size: 9px !important; background: rgba(10,18,28,0.7) !important; color: #475569 !important; }
.leaflet-control-attribution a { color: #475569 !important; }
.leaflet-tooltip.putin-tip { background: rgba(15,40,25,0.92) !important; border: 1.5px solid #22c55e !important; border-radius: 6px !important; color: #4ade80 !important; font-size: 11px !important; font-weight: 700 !important; padding: 4px 8px !important; box-shadow: none !important; }
.leaflet-tooltip.putin-tip::before { border-right-color: #22c55e !important; }
</style>
</head>
<body>

<div id="topbar">
  <h1>Barge Tracker</h1>
  <div class="status-pill">
    <div class="live-dot"></div>
    <span id="vessel-count">0 vessels</span>
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
  <div class="sheet-label">Nearby vessels</div>
  <div class="vessel-scroll" id="vessel-list">
    <div class="empty-state">Waiting for AIS data…</div>
  </div>
</div>

<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify it loads**

Start the server (`node server.js`) and open http://localhost:3000. You should see the dark UI shell with an empty map area and "Waiting for AIS data…" in the bottom strip.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: frontend HTML shell and CSS"
```

---

## Task 6: Frontend — map init and vessel logic

**Files:**
- Create: `public/app.js`

All map logic, SSE wiring, danger zone detection, and UI updates live here.

- [ ] **Step 1: Create `public/app.js`**

```js
// ── Constants ────────────────────────────────────────────────────────────────
const OVRC = [39.2718, -81.5555];          // OVRC Launch, Parkersburg WV
const DANGER_RADIUS_M = 3218;              // 2 miles in metres
const MAP_CENTER = [39.2860, -81.5570];    // midpoint between launch and Neal Island
const MAP_ZOOM = 13;

// Direction from COG (course over ground, degrees true)
// Ohio River in this stretch runs roughly N–S, so:
//   COG 315–45  → Upriver  (northbound, toward Vienna)
//   COG 135–225 → Downriver (southbound, toward Parkersburg)
function cogToDirection(cog) {
  const c = ((cog % 360) + 360) % 360;
  if (c >= 315 || c < 45) return 'Upriver';
  if (c >= 135 && c < 225) return 'Downriver';
  return 'Crossing'; // rare on this stretch
}

// Haversine distance between two [lat,lon] points, returns metres
function distanceM(a, b) {
  const R = 6371000;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ETA in minutes given distance (metres) and speed (knots)
function etaMinutes(distM, sog) {
  if (!sog || sog < 0.5) return null; // anchored or drifting
  const speedMs = sog * 0.514444; // knots → m/s
  return Math.round(distM / speedMs / 60);
}

// ── Map setup ────────────────────────────────────────────────────────────────
const map = L.map('map', { center: MAP_CENTER, zoom: MAP_ZOOM, zoomControl: true });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OSM contributors',
  maxZoom: 18,
}).addTo(map);

// Put-in marker
const putinIcon = L.divIcon({
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#22c55e;border:3px solid white;box-shadow:0 0 0 4px rgba(34,197,94,0.25),0 3px 8px rgba(0,0,0,0.5);"></div>`,
  className: '', iconSize: [18, 18], iconAnchor: [9, 9],
});
L.marker(OVRC, { icon: putinIcon }).addTo(map)
  .bindTooltip('OVRC Launch', { permanent: true, direction: 'right', className: 'putin-tip', offset: [10, 0] });

// Danger zone ring
L.circle(OVRC, {
  radius: DANGER_RADIUS_M, color: '#dc2626', fillColor: '#dc2626',
  fillOpacity: 0.06, weight: 1.5, dashArray: '7,5',
}).addTo(map);

// ── Vessel state ─────────────────────────────────────────────────────────────
const vesselMarkers = new Map(); // mmsi → L.marker
const vesselData    = new Map(); // mmsi → vessel object

let alertDismissedFor = null; // mmsi of last dismissed alert

function bargeIcon(vessel) {
  const dist = distanceM(OVRC, [vessel.lat, vessel.lon]);
  const inZone = dist <= DANGER_RADIUS_M;
  const color = inZone ? '#dc2626' : (cogToDirection(vessel.cog) === 'Upriver' ? '#f59e0b' : '#2563eb');
  const pulse = inZone ? `<style>@keyframes rng{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.4);opacity:0}}.rng{position:absolute;inset:-6px;border-radius:4px;border:2px solid #dc2626;animation:rng 1.3s ease-out infinite;}</style><div class="rng"></div>` : '';
  return L.divIcon({
    html: `<div style="position:relative;width:32px;height:12px">${pulse}<div style="width:32px;height:12px;background:${color};border-radius:3px;border:2px solid rgba(255,255,255,0.4);box-shadow:0 2px 10px rgba(0,0,0,0.6);transform:rotate(${vessel.cog}deg);transform-origin:center;"></div></div>`,
    className: '', iconSize: [32, 12], iconAnchor: [16, 6],
  });
}

function popupHtml(vessel) {
  const dist = distanceM(OVRC, [vessel.lat, vessel.lon]);
  const inZone = dist <= DANGER_RADIUS_M;
  const dir = cogToDirection(vessel.cog);
  const eta = etaMinutes(dist, vessel.sog);
  const etaStr = eta !== null ? `~${eta} min to OVRC Launch` : 'Anchored / not moving';
  return `
    <div class="popup-name">${vessel.name}</div>
    <div class="popup-row">Direction: <span>${dir}</span></div>
    <div class="popup-row">Speed: <span>${vessel.sog.toFixed(1)} kts</span></div>
    <div class="popup-row">MMSI: <span>${vessel.mmsi}</span></div>
    ${inZone ? `<div class="popup-eta">⚠ ${etaStr}</div>` : `<div class="popup-row">ETA: <span>${etaStr}</span></div>`}
  `;
}

function chipHtml(vessel) {
  const dist = distanceM(OVRC, [vessel.lat, vessel.lon]);
  const inZone = dist <= DANGER_RADIUS_M;
  const dir = cogToDirection(vessel.cog);
  const eta = etaMinutes(dist, vessel.sog);
  const dirIcon = dir === 'Upriver' ? '🔴' : dir === 'Downriver' ? '🔵' : '🟡';
  const etaLine = inZone && eta !== null
    ? `<div class="veta">⚠ ~${eta} min to launch</div>`
    : `<div class="vdetail">${eta !== null ? `~${eta} min away` : 'Anchored'}</div>`;
  return `
    <div class="vname">${dirIcon} ${vessel.name}</div>
    <div class="vdetail">${dir} · ${vessel.sog.toFixed(1)} kts</div>
    ${etaLine}
  `;
}

function applyVessel(vessel) {
  vesselData.set(vessel.mmsi, vessel);

  if (vesselMarkers.has(vessel.mmsi)) {
    const m = vesselMarkers.get(vessel.mmsi);
    m.setLatLng([vessel.lat, vessel.lon]);
    m.setIcon(bargeIcon(vessel));
    if (m.isPopupOpen()) m.setPopupContent(popupHtml(vessel));
  } else {
    const m = L.marker([vessel.lat, vessel.lon], { icon: bargeIcon(vessel) })
      .addTo(map)
      .bindPopup(popupHtml(vessel), { maxWidth: 240, offset: [0, -6] });
    m.on('click', () => focusVessel(vessel.mmsi));
    vesselMarkers.set(vessel.mmsi, m);
  }

  renderList();
  checkDangerZone();
}

function removeVessel(mmsi) {
  if (vesselMarkers.has(mmsi)) {
    map.removeLayer(vesselMarkers.get(mmsi));
    vesselMarkers.delete(mmsi);
  }
  vesselData.delete(mmsi);
  renderList();
}

function focusVessel(mmsi) {
  const vessel = vesselData.get(mmsi);
  if (!vessel) return;
  map.setView([vessel.lat, vessel.lon], 15, { animate: true, duration: 0.5 });
  vesselMarkers.get(mmsi)?.openPopup();
}

// ── UI rendering ─────────────────────────────────────────────────────────────
function renderList() {
  const list = document.getElementById('vessel-list');
  const count = vesselData.size;

  document.getElementById('vessel-count').textContent =
    count === 1 ? '1 vessel' : `${count} vessels`;

  if (count === 0) {
    list.innerHTML = '<div class="empty-state">No vessels in range</div>';
    return;
  }

  // Sort: danger zone first, then by distance
  const sorted = [...vesselData.values()].sort((a, b) => {
    const da = distanceM(OVRC, [a.lat, a.lon]);
    const db = distanceM(OVRC, [b.lat, b.lon]);
    const aIn = da <= DANGER_RADIUS_M;
    const bIn = db <= DANGER_RADIUS_M;
    if (aIn !== bIn) return aIn ? -1 : 1;
    return da - db;
  });

  list.innerHTML = sorted.map(v => {
    const dist = distanceM(OVRC, [v.lat, v.lon]);
    const inZone = dist <= DANGER_RADIUS_M;
    return `<div class="vessel-chip ${inZone ? 'danger' : ''}" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`;
  }).join('');
}

// ── Alert banner ─────────────────────────────────────────────────────────────
function checkDangerZone() {
  for (const vessel of vesselData.values()) {
    const dist = distanceM(OVRC, [vessel.lat, vessel.lon]);
    if (dist <= DANGER_RADIUS_M && vessel.mmsi !== alertDismissedFor) {
      showAlert(vessel, dist);
      return;
    }
  }
  // No vessels in zone
  document.getElementById('alert-banner').classList.add('hidden');
  document.getElementById('map').classList.remove('with-alert');
  alertDismissedFor = null;
}

function showAlert(vessel, distM) {
  const dir = cogToDirection(vessel.cog);
  const eta = etaMinutes(distM, vessel.sog);
  document.getElementById('alert-name').textContent = `${vessel.name} approaching OVRC Launch`;
  document.getElementById('alert-detail').textContent =
    `${dir} · ${vessel.sog.toFixed(1)} kts${eta !== null ? ` · ~${eta} min away` : ''}`;
  document.getElementById('alert-banner').classList.remove('hidden');
  document.getElementById('map').classList.add('with-alert');
}

function dismissAlert() {
  // Find which vessel is in zone and suppress its alert until it updates again
  for (const vessel of vesselData.values()) {
    const dist = distanceM(OVRC, [vessel.lat, vessel.lon]);
    if (dist <= DANGER_RADIUS_M) { alertDismissedFor = vessel.mmsi; break; }
  }
  document.getElementById('alert-banner').classList.add('hidden');
  document.getElementById('map').classList.remove('with-alert');
}

// Expose for inline onclick handlers
window.focusVessel = focusVessel;
window.dismissAlert = dismissAlert;

// ── SSE connection ────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/events');

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      msg.vessels.forEach(applyVessel);
    } else if (msg.type === 'update') {
      applyVessel(msg.vessel);
    } else if (msg.type === 'remove') {
      removeVessel(msg.mmsi);
    }
  };

  es.onerror = () => {
    console.warn('SSE disconnected — will auto-reconnect');
  };
}

connectSSE();
```

- [ ] **Step 2: Test the full app**

Start the server:

```bash
node server.js
```

Open http://localhost:3000. Verify:
- Map loads centered on the Ohio River near Parkersburg
- OVRC Launch marker visible with tooltip
- 2-mile danger zone ring visible
- Bottom strip shows "No vessels in range" (or live vessels if AIS is active)
- Status pill shows "0 vessels" (or count)

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: frontend map logic, SSE consumer, danger zone alerts"
```

---

## Task 7: Update launch config and add README

**Files:**
- Modify: `.claude/launch.json`
- Create: `README.md`

- [ ] **Step 1: Update `.claude/launch.json`** to point at the real Node app

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "barge-tracker",
      "runtimeExecutable": "node",
      "runtimeArgs": ["server.js"],
      "port": 3000
    }
  ]
}
```

- [ ] **Step 2: Create `README.md`**

```markdown
# Ohio River Barge Tracker

Live AIS vessel tracker for the Ohio River between OVRC Launch (Parkersburg WV) and Neal Island. Built to check for barge traffic before rowing.

## Setup

1. Sign up for a free API key at https://aisstream.io
2. Copy your key into `.env`:
   ```
   AISSTREAM_API_KEY=your_key_here
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```
5. Open http://localhost:3000

## Viewing on your phone via ngrok

1. Install ngrok: https://ngrok.com/download
2. Start the app: `npm start`
3. In a second terminal: `ngrok http 3000`
4. Open the `https://...ngrok-free.app` URL on your Pixel

The ngrok URL changes each session unless you have a paid plan. Free plan is fine for pre-row checks.

## Danger zone

A 2-mile radius circle is drawn around OVRC Launch. When any vessel enters that zone, a red alert banner fires with the vessel name, direction, speed, and estimated minutes to the launch site.

## AIS coverage note

Not all vessels broadcast AIS. Large commercial barges and towboats are required to carry AIS — smaller recreational craft are not. Coverage on the Ohio River is generally good for commercial traffic.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/launch.json README.md
git commit -m "chore: update launch config and add README with ngrok instructions"
```

---

## Task 8: End-to-end test on phone

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Start ngrok**

```bash
ngrok http 3000
```

Copy the `https://...ngrok-free.app` URL from ngrok output.

- [ ] **Step 3: Open on Pixel**

Open the ngrok URL in Chrome on your Pixel. Verify:
- Map loads showing Ohio River, OVRC Launch marker, danger zone ring
- Vessel chips appear when AIS data arrives
- Tapping a chip flies the map to that vessel
- Alert banner fires if a vessel is within 2 miles of OVRC Launch
- Banner dismiss button is easily tappable

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: ready for field use"
```

---

## Task 9: Browser-direct single-file version (GitHub Pages deployment)

**Files:**
- Create: `standalone/index.html`

This is a fully self-contained alternative to the Node.js server. The browser connects directly to AISStream.io via WebSocket — no server required. Host it for free on GitHub Pages and open it on your Pixel anytime. All vessel logic is identical to Tasks 5–6; only the data transport changes (browser WebSocket instead of SSE).

**Note:** Your AISStream.io API key will be visible in the page source. This is acceptable for a free personal key — there is no billing risk.

- [ ] **Step 1: Create `standalone/` directory and `standalone/index.html`**

```bash
mkdir standalone
```

Create `standalone/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0f1923">
<title>Barge Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; overflow: hidden; background: #0f1923; }

#topbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
  background: rgba(10,18,28,0.96); border-bottom: 1px solid #1e3a5f;
  padding: 14px 16px 12px; display: flex; align-items: center; justify-content: space-between;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
#topbar h1 { font-size: 1.1rem; font-weight: 700; color: #f8fafc; font-family: -apple-system, sans-serif; }
.status-pill {
  display: flex; align-items: center; gap: 6px;
  background: #0d2d1a; border: 1px solid #166534;
  border-radius: 20px; padding: 4px 10px;
  font-size: 0.72rem; color: #4ade80; font-family: -apple-system, sans-serif;
}
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)} }

#alert-banner {
  position: fixed; top: 57px; left: 0; right: 0; z-index: 1000;
  background: #450a0a; border-bottom: 2px solid #dc2626;
  padding: 12px 16px; display: flex; align-items: center; gap: 12px;
  font-family: -apple-system, sans-serif; animation: slideDown 0.25s ease;
}
@keyframes slideDown { from{transform:translateY(-100%)} to{transform:translateY(0)} }
#alert-banner.hidden { display: none; }
#alert-banner .icon { font-size: 1.8rem; flex-shrink: 0; }
#alert-banner strong { display: block; color: #fca5a5; font-size: 0.95rem; line-height: 1.3; }
#alert-banner small { color: #f87171; font-size: 0.78rem; }
#alert-banner .close {
  margin-left: auto; flex-shrink: 0; color: #f87171; font-size: 1.4rem;
  width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; border-radius: 8px;
}

#map { position: fixed; top: 57px; bottom: 120px; left: 0; right: 0; transition: top 0.2s; }
#map.with-alert { top: 113px; }

#sheet {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 1000;
  background: rgba(10,18,28,0.97); border-top: 1px solid #1e3a5f;
  border-radius: 18px 18px 0 0; backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px); height: 120px; font-family: -apple-system, sans-serif;
}
.sheet-handle { width: 36px; height: 4px; background: #334155; border-radius: 2px; margin: 10px auto 8px; }
.sheet-label { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #475569; padding: 0 16px; margin-bottom: 8px; }
.vessel-scroll { display: flex; gap: 10px; overflow-x: auto; padding: 0 16px 12px; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.vessel-scroll::-webkit-scrollbar { display: none; }
.vessel-chip { background: #131f2e; border: 1.5px solid #2d4057; border-radius: 12px; padding: 10px 14px; min-width: 155px; flex-shrink: 0; cursor: pointer; }
.vessel-chip:active { opacity: 0.7; }
.vessel-chip.danger { border-color: #dc2626; background: #1f0909; }
.vessel-chip .vname { font-size: 0.85rem; font-weight: 700; color: #f1f5f9; }
.vessel-chip .vdetail { font-size: 0.72rem; color: #64748b; margin-top: 3px; }
.vessel-chip .veta { font-size: 0.72rem; color: #fbbf24; margin-top: 3px; font-weight: 600; }
.empty-state { padding: 0 16px; font-size: 0.75rem; color: #334155; display: flex; align-items: center; height: 56px; }

.leaflet-popup-content-wrapper { background: #131f2e !important; border: 1.5px solid #3b82f6 !important; border-radius: 12px !important; box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important; color: #e2e8f0 !important; }
.leaflet-popup-tip { background: #131f2e !important; }
.leaflet-popup-content { margin: 12px 16px !important; font-family: -apple-system, sans-serif !important; min-width: 180px; }
.popup-name { font-size: 1rem; font-weight: 700; color: #f8fafc; margin-bottom: 8px; }
.popup-row { font-size: 0.8rem; color: #64748b; margin: 4px 0; }
.popup-row span { color: #e2e8f0; font-weight: 500; }
.popup-eta { margin-top: 10px; background: #450a0a; border: 1px solid #dc2626; border-radius: 7px; padding: 7px 10px; font-size: 0.78rem; color: #fca5a5; font-weight: 600; }
.leaflet-control-zoom { border: 1px solid #2d4057 !important; border-radius: 10px !important; overflow: hidden; }
.leaflet-control-zoom a { background: #131f2e !important; color: #94a3b8 !important; border-color: #2d4057 !important; width: 40px !important; height: 40px !important; line-height: 40px !important; font-size: 1.2rem !important; }
.leaflet-control-zoom a:hover { background: #1e2d3d !important; }
.leaflet-control-attribution { font-size: 9px !important; background: rgba(10,18,28,0.7) !important; color: #475569 !important; }
.leaflet-control-attribution a { color: #475569 !important; }
.leaflet-tooltip.putin-tip { background: rgba(15,40,25,0.92) !important; border: 1.5px solid #22c55e !important; border-radius: 6px !important; color: #4ade80 !important; font-size: 11px !important; font-weight: 700 !important; padding: 4px 8px !important; box-shadow: none !important; }
.leaflet-tooltip.putin-tip::before { border-right-color: #22c55e !important; }
</style>
</head>
<body>

<div id="topbar">
  <h1>Barge Tracker</h1>
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
  <div class="sheet-label">Nearby vessels</div>
  <div class="vessel-scroll" id="vessel-list">
    <div class="empty-state">Connecting to AIS…</div>
  </div>
</div>

<script>
// ── Config — replace with your AISStream.io key ───────────────────────────────
const AISSTREAM_API_KEY = 'YOUR_KEY_HERE';

// ── Constants ────────────────────────────────────────────────────────────────
const OVRC            = [39.2718, -81.5555];
const DANGER_RADIUS_M = 3218;               // 2 miles
const MAP_CENTER      = [39.2860, -81.5570];
const MAP_ZOOM        = 13;
const BOUNDING_BOX    = [[39.24, -81.60], [39.35, -81.50]];
const STALE_MS        = 10 * 60 * 1000;    // 10 minutes

// ── Helpers ──────────────────────────────────────────────────────────────────
function cogToDirection(cog) {
  const c = ((cog % 360) + 360) % 360;
  if (c >= 315 || c < 45)   return 'Upriver';
  if (c >= 135 && c < 225)  return 'Downriver';
  return 'Crossing';
}

function distanceM(a, b) {
  const R = 6371000;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function etaMinutes(distM, sog) {
  if (!sog || sog < 0.5) return null;
  return Math.round(distM / (sog * 0.514444) / 60);
}

// ── Map ──────────────────────────────────────────────────────────────────────
const map = L.map('map', { center: MAP_CENTER, zoom: MAP_ZOOM });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OSM contributors', maxZoom: 18,
}).addTo(map);

const putinIcon = L.divIcon({
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#22c55e;border:3px solid white;box-shadow:0 0 0 4px rgba(34,197,94,0.25),0 3px 8px rgba(0,0,0,0.5);"></div>`,
  className: '', iconSize: [18,18], iconAnchor: [9,9],
});
L.marker(OVRC, { icon: putinIcon }).addTo(map)
  .bindTooltip('OVRC Launch', { permanent: true, direction: 'right', className: 'putin-tip', offset: [10,0] });

L.circle(OVRC, {
  radius: DANGER_RADIUS_M, color: '#dc2626', fillColor: '#dc2626',
  fillOpacity: 0.06, weight: 1.5, dashArray: '7,5',
}).addTo(map);

// ── Vessel state ─────────────────────────────────────────────────────────────
const vesselMarkers = new Map();
const vesselData    = new Map();
let alertDismissedFor = null;

function bargeIcon(vessel) {
  const dist   = distanceM(OVRC, [vessel.lat, vessel.lon]);
  const inZone = dist <= DANGER_RADIUS_M;
  const color  = inZone ? '#dc2626' : (cogToDirection(vessel.cog) === 'Upriver' ? '#f59e0b' : '#2563eb');
  const pulse  = inZone
    ? `<style>@keyframes rng{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.4);opacity:0}}.rng{position:absolute;inset:-6px;border-radius:4px;border:2px solid #dc2626;animation:rng 1.3s ease-out infinite;}</style><div class="rng"></div>`
    : '';
  return L.divIcon({
    html: `<div style="position:relative;width:32px;height:12px">${pulse}<div style="width:32px;height:12px;background:${color};border-radius:3px;border:2px solid rgba(255,255,255,0.4);box-shadow:0 2px 10px rgba(0,0,0,0.6);transform:rotate(${vessel.cog}deg);transform-origin:center;"></div></div>`,
    className: '', iconSize: [32,12], iconAnchor: [16,6],
  });
}

function popupHtml(vessel) {
  const dist   = distanceM(OVRC, [vessel.lat, vessel.lon]);
  const inZone = dist <= DANGER_RADIUS_M;
  const dir    = cogToDirection(vessel.cog);
  const eta    = etaMinutes(dist, vessel.sog);
  const etaStr = eta !== null ? `~${eta} min to OVRC Launch` : 'Anchored / not moving';
  return `
    <div class="popup-name">${vessel.name}</div>
    <div class="popup-row">Direction: <span>${dir}</span></div>
    <div class="popup-row">Speed: <span>${vessel.sog.toFixed(1)} kts</span></div>
    <div class="popup-row">MMSI: <span>${vessel.mmsi}</span></div>
    ${inZone ? `<div class="popup-eta">⚠ ${etaStr}</div>` : `<div class="popup-row">ETA: <span>${etaStr}</span></div>`}
  `;
}

function chipHtml(vessel) {
  const dist   = distanceM(OVRC, [vessel.lat, vessel.lon]);
  const inZone = dist <= DANGER_RADIUS_M;
  const dir    = cogToDirection(vessel.cog);
  const eta    = etaMinutes(dist, vessel.sog);
  const icon   = dir === 'Upriver' ? '🔴' : dir === 'Downriver' ? '🔵' : '🟡';
  const etaLine = inZone && eta !== null
    ? `<div class="veta">⚠ ~${eta} min to launch</div>`
    : `<div class="vdetail">${eta !== null ? `~${eta} min away` : 'Anchored'}</div>`;
  return `
    <div class="vname">${icon} ${vessel.name}</div>
    <div class="vdetail">${dir} · ${vessel.sog.toFixed(1)} kts</div>
    ${etaLine}
  `;
}

function applyVessel(vessel) {
  vesselData.set(vessel.mmsi, vessel);
  if (vesselMarkers.has(vessel.mmsi)) {
    const m = vesselMarkers.get(vessel.mmsi);
    m.setLatLng([vessel.lat, vessel.lon]);
    m.setIcon(bargeIcon(vessel));
    if (m.isPopupOpen()) m.setPopupContent(popupHtml(vessel));
  } else {
    const m = L.marker([vessel.lat, vessel.lon], { icon: bargeIcon(vessel) })
      .addTo(map)
      .bindPopup(popupHtml(vessel), { maxWidth: 240, offset: [0,-6] });
    m.on('click', () => focusVessel(vessel.mmsi));
    vesselMarkers.set(vessel.mmsi, m);
  }
  renderList();
  checkDangerZone();
}

function removeVessel(mmsi) {
  if (vesselMarkers.has(mmsi)) { map.removeLayer(vesselMarkers.get(mmsi)); vesselMarkers.delete(mmsi); }
  vesselData.delete(mmsi);
  renderList();
}

function focusVessel(mmsi) {
  const v = vesselData.get(mmsi);
  if (!v) return;
  map.setView([v.lat, v.lon], 15, { animate: true, duration: 0.5 });
  vesselMarkers.get(mmsi)?.openPopup();
}

function renderList() {
  const list  = document.getElementById('vessel-list');
  const count = vesselData.size;
  document.getElementById('vessel-count').textContent = count === 1 ? '1 vessel' : `${count} vessels`;
  if (count === 0) { list.innerHTML = '<div class="empty-state">No vessels in range</div>'; return; }
  const sorted = [...vesselData.values()].sort((a, b) => {
    const da = distanceM(OVRC, [a.lat, a.lon]);
    const db = distanceM(OVRC, [b.lat, b.lon]);
    const aIn = da <= DANGER_RADIUS_M, bIn = db <= DANGER_RADIUS_M;
    if (aIn !== bIn) return aIn ? -1 : 1;
    return da - db;
  });
  list.innerHTML = sorted.map(v => {
    const inZone = distanceM(OVRC, [v.lat, v.lon]) <= DANGER_RADIUS_M;
    return `<div class="vessel-chip ${inZone ? 'danger' : ''}" onclick="focusVessel('${v.mmsi}')">${chipHtml(v)}</div>`;
  }).join('');
}

function checkDangerZone() {
  for (const vessel of vesselData.values()) {
    const dist = distanceM(OVRC, [vessel.lat, vessel.lon]);
    if (dist <= DANGER_RADIUS_M && vessel.mmsi !== alertDismissedFor) {
      const dir = cogToDirection(vessel.cog);
      const eta = etaMinutes(dist, vessel.sog);
      document.getElementById('alert-name').textContent = `${vessel.name} approaching OVRC Launch`;
      document.getElementById('alert-detail').textContent =
        `${dir} · ${vessel.sog.toFixed(1)} kts${eta !== null ? ` · ~${eta} min away` : ''}`;
      document.getElementById('alert-banner').classList.remove('hidden');
      document.getElementById('map').classList.add('with-alert');
      return;
    }
  }
  document.getElementById('alert-banner').classList.add('hidden');
  document.getElementById('map').classList.remove('with-alert');
  alertDismissedFor = null;
}

function dismissAlert() {
  for (const vessel of vesselData.values()) {
    if (distanceM(OVRC, [vessel.lat, vessel.lon]) <= DANGER_RADIUS_M) {
      alertDismissedFor = vessel.mmsi; break;
    }
  }
  document.getElementById('alert-banner').classList.add('hidden');
  document.getElementById('map').classList.remove('with-alert');
}

window.focusVessel  = focusVessel;
window.dismissAlert = dismissAlert;

// ── AISStream.io — direct browser WebSocket ──────────────────────────────────
const RECONNECT_MS = 5000;

function connectAIS() {
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.addEventListener('open', () => {
    console.log('AISStream connected');
    document.getElementById('vessel-count').textContent = '0 vessels';
    ws.send(JSON.stringify({
      APIKey: AISSTREAM_API_KEY,
      BoundingBoxes: [BOUNDING_BOX],
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.MessageType !== 'PositionReport') return;
      const pos  = msg.Message.PositionReport;
      const meta = msg.MetaData || {};
      applyVessel({
        mmsi:      String(pos.UserID),
        name:      (meta.ShipName || '').trim() || `MMSI ${pos.UserID}`,
        lat:       pos.Latitude,
        lon:       pos.Longitude,
        sog:       pos.Sog,
        cog:       pos.Cog,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('AIS parse error:', err);
    }
  });

  ws.addEventListener('error', (e) => console.error('AISStream error', e));

  ws.addEventListener('close', () => {
    console.log('AISStream disconnected — reconnecting…');
    document.getElementById('vessel-count').textContent = 'Reconnecting…';
    setTimeout(connectAIS, RECONNECT_MS);
  });
}

// Prune stale vessels every minute
setInterval(() => {
  const now = Date.now();
  for (const [mmsi, v] of vesselData) {
    if (now - v.updatedAt > STALE_MS) removeVessel(mmsi);
  }
}, 60_000);

connectAIS();
</script>
</body>
</html>
```

- [ ] **Step 2: Replace `YOUR_KEY_HERE` with the real AISStream.io API key**

Edit the top of the `<script>` block in `standalone/index.html`:

```js
const AISSTREAM_API_KEY = 'abc123youractualkey';
```

- [ ] **Step 3: Test locally**

Open `standalone/index.html` directly in Chrome (no server needed — `File > Open` or drag into browser). Verify:
- Map loads on the Ohio River near Parkersburg
- OVRC Launch marker and danger zone ring visible
- Status pill shows "Connecting…" then "0 vessels" once AIS connects
- Browser console shows `AISStream connected`

- [ ] **Step 4: Push to GitHub and enable GitHub Pages**

```bash
git add standalone/index.html
git commit -m "feat: standalone browser-direct version for GitHub Pages"
git remote add origin https://github.com/YOUR_USERNAME/barge-tracker.git
git push -u origin main
```

Then in the GitHub repo:
1. Go to **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/ (root)`
4. Save

GitHub Pages URL will be: `https://YOUR_USERNAME.github.io/barge-tracker/standalone/`

Give it 1–2 minutes to deploy, then open that URL on your Pixel.

- [ ] **Step 5: Bookmark on Pixel**

In Chrome on your Pixel, open the GitHub Pages URL, tap the menu (⋮) → **Add to Home screen**. Now it's one tap away from your home screen before every row.

- [ ] **Step 6: Commit**

```bash
git push
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Node.js + Express server
- ✅ AISStream.io WebSocket with bounding box filter
- ✅ SSE push to browser
- ✅ Leaflet map, OSM tiles, centered on Ohio River
- ✅ OVRC Launch marker
- ✅ 2-mile danger zone circle
- ✅ Red dismissable alert banner with vessel name, speed, direction, ETA
- ✅ Bottom scrollable vessel chip strip
- ✅ Tap chip → fly to vessel + open popup
- ✅ Dark mobile-first theme
- ✅ `.env` for API key
- ✅ `.gitignore` excludes `.env` and `node_modules`
- ✅ ngrok instructions in README
- ✅ `launch.json` updated for real server
- ✅ Stale vessel pruning

- ✅ Standalone single-file version with browser-direct AISStream.io WebSocket
- ✅ GitHub Pages deployment instructions
- ✅ Home screen bookmark instructions for Pixel

**Placeholder scan:** None found — all steps contain full code.

**Type consistency:** `vessel` objects have consistent shape (`mmsi`, `name`, `lat`, `lon`, `sog`, `cog`, `updatedAt`) throughout `server.js`, `public/app.js`, and `standalone/index.html`.
