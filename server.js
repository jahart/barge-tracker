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

  const snapshot = JSON.stringify({ type: 'snapshot', vessels: [...vessels.values()] });
  res.write(`data: ${snapshot}\n\n`);

  const aisState = aisConnected
    ? JSON.stringify({ type: 'ais-connected' })
    : JSON.stringify({ type: 'ais-reconnecting', reconnectAt });
  res.write(`data: ${aisState}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

const BOUNDING_BOX         = [[39.05, -81.80], [39.42, -81.25]];
const RECONNECT_DELAY_MS   = 5000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // 5 minutes max
let reconnectDelay = RECONNECT_DELAY_MS;
let aisConnected   = false;
let reconnectAt    = null;

function connectAIS() {
  if (!process.env.AISSTREAM_API_KEY) {
    console.warn('AISSTREAM_API_KEY not set — running without live data');
    return;
  }

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    reconnectDelay = RECONNECT_DELAY_MS; // reset backoff on success
    aisConnected   = true;
    reconnectAt    = null;
    console.log('AISStream connected');
    broadcast({ type: 'ais-connected' });
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

      const pos  = msg.Message.PositionReport;
      const meta = msg.MetaData || {};

      const vessel = {
        mmsi:      String(pos.UserID),
        name:      (meta.ShipName || '').trim() || `MMSI ${pos.UserID}`,
        lat:       pos.Latitude,
        lon:       pos.Longitude,
        sog:       pos.Sog,
        cog:       pos.Cog,
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
    aisConnected = false;
    reconnectAt  = Date.now() + reconnectDelay;
    console.log(`AISStream disconnected — reconnecting in ${reconnectDelay / 1000}s`);
    broadcast({ type: 'ais-reconnecting', reconnectAt });
    setTimeout(connectAIS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  });
}

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

app.listen(PORT, () => {
  console.log(`Barge Tracker running on http://localhost:${PORT}`);
  connectAIS();
});
