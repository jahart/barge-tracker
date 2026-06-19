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
