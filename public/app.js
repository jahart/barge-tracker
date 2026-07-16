// ── Constants ────────────────────────────────────────────────────────────────
const OVRC = [39.2833, -81.5631];          // OVRC Launch at Memorial Bridge, Parkersburg WV
const ZONE_CENTER = [39.2851, -81.5631];   // Danger zone center — 1/8 mi north of launch
const DANGER_RADIUS_M = 4828;              // 3 miles in metres
const MAP_CENTER = [39.2900, -81.5631];    // midpoint between launch and Neal Island
const MAP_ZOOM = 13;
const BELLEVILLE      = [39.1193, -81.7425]; // Belleville Locks and Dam — river mile 203.9, south of OVRC
const WILLOW_ISLAND   = [39.3592, -81.3192]; // Willow Island Locks and Dam — river mile 161.7, north of OVRC
const NEARBY_RADIUS_M = 12875;               // ~8 miles — matches the old bounding box's rough coverage

// Direction from COG (course over ground, degrees true)
function cogToDirection(cog) {
  const c = ((cog % 360) + 360) % 360;
  if (c >= 315 || c < 45) return 'Upriver';
  if (c >= 135 && c < 225) return 'Downriver';
  return 'Crossing';
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
  if (!sog || sog < 0.5) return null;
  const speedMs = sog * 0.514444;
  return Math.round(distM / speedMs / 60);
}

// Classifies a vessel outside the Nearby radius as approaching from a lock, or null
function approachSource(vessel) {
  const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
  if (dist <= NEARBY_RADIUS_M) return null;
  const dir = cogToDirection(vessel.cog);
  if (vessel.lat < OVRC[0] && dir === 'Upriver') return 'belleville';
  if (vessel.lat > OVRC[0] && dir === 'Downriver') return 'willow-island';
  return null;
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
L.circle(ZONE_CENTER, {
  radius: DANGER_RADIUS_M, color: '#dc2626', fillColor: '#dc2626',
  fillOpacity: 0.06, weight: 1.5, dashArray: '7,5',
}).addTo(map);

// ── Vessel state ─────────────────────────────────────────────────────────────
const vesselMarkers = new Map();
const vesselData    = new Map();

let alertDismissedFor = null;

function bargeIcon(vessel) {
  const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
  const inZone = dist <= DANGER_RADIUS_M;
  // Red only when in danger zone; amber for upriver outside zone; blue for downriver
  const color = inZone ? '#dc2626' : (cogToDirection(vessel.cog) === 'Upriver' ? '#f59e0b' : '#2563eb');
  const pulse = inZone ? `<style>@keyframes rng{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.4);opacity:0}}.rng{position:absolute;inset:-6px;border-radius:4px;border:2px solid #dc2626;animation:rng 1.3s ease-out infinite;}</style><div class="rng"></div>` : '';
  return L.divIcon({
    html: `<div style="position:relative;width:32px;height:12px">${pulse}<div style="width:32px;height:12px;background:${color};border-radius:3px;border:2px solid rgba(255,255,255,0.4);box-shadow:0 2px 10px rgba(0,0,0,0.6);transform:rotate(${vessel.cog}deg);transform-origin:center;"></div></div>`,
    className: '', iconSize: [32, 12], iconAnchor: [16, 6],
  });
}

function popupHtml(vessel) {
  const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
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
  const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
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

// ── Alert banner ─────────────────────────────────────────────────────────────
function checkDangerZone() {
  for (const vessel of vesselData.values()) {
    const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
    if (dist <= DANGER_RADIUS_M && vessel.mmsi !== alertDismissedFor) {
      showAlert(vessel, dist);
      return;
    }
  }
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
  for (const vessel of vesselData.values()) {
    const dist = distanceM(ZONE_CENTER, [vessel.lat, vessel.lon]);
    if (dist <= DANGER_RADIUS_M) { alertDismissedFor = vessel.mmsi; break; }
  }
  document.getElementById('alert-banner').classList.add('hidden');
  document.getElementById('map').classList.remove('with-alert');
}

window.focusVessel = focusVessel;
window.dismissAlert = dismissAlert;
window.toggleApproachPanel = toggleApproachPanel;

// ── Reconnect countdown ───────────────────────────────────────────────────────
let reconnectCountdown = null;

function showReconnecting(reconnectAt) {
  if (reconnectCountdown) clearInterval(reconnectCountdown);
  document.querySelector('.live-dot').classList.add('disconnected');
  const countEl = document.getElementById('vessel-count');
  const tick = () => {
    const rem = Math.max(0, reconnectAt - Date.now());
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    countEl.textContent = `Reconnecting ${m}:${String(s).padStart(2, '0')}`;
    if (rem === 0) clearInterval(reconnectCountdown);
  };
  tick();
  reconnectCountdown = setInterval(tick, 1000);
}

function clearReconnecting() {
  if (reconnectCountdown) { clearInterval(reconnectCountdown); reconnectCountdown = null; }
  document.querySelector('.live-dot').classList.remove('disconnected');
  renderList();
}

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
    } else if (msg.type === 'ais-reconnecting') {
      showReconnecting(msg.reconnectAt);
    } else if (msg.type === 'ais-connected') {
      clearReconnecting();
    }
  };

  es.onerror = () => {
    console.warn('SSE disconnected — will auto-reconnect');
  };
}

connectSSE();
syncMapOffset();
