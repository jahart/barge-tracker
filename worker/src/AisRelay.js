import { parsePositionReport, findStale, STALE_THRESHOLD_MS } from './lib/vessels.js';

const BOUNDING_BOX = [[39.05, -81.80], [39.42, -81.25]];
const CORS_ORIGIN = 'https://jahart.github.io';
const POLL_WINDOW_MS = 8000;
const CONNECT_TIMEOUT_MS = 5000;

export class AisRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // Opens the AISStream WebSocket just long enough to catch whatever position
  // reports arrive in the window, then closes it. Kept short and per-request
  // (rather than a permanent connection) so the Durable Object stays idle
  // between polls instead of burning Workers Free plan's daily duration
  // allowance by staying active 24/7.
  pollAis(vessels, now) {
    if (!this.env.AISSTREAM_API_KEY) {
      console.warn('AISSTREAM_API_KEY not set — running without live data');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
      let connected = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(windowTimer);
        try { ws.close(); } catch { /* already closed */ }
        resolve(result);
      };

      const connectTimer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
      let windowTimer;

      ws.addEventListener('open', () => {
        connected = true;
        clearTimeout(connectTimer);
        ws.send(JSON.stringify({
          APIKey: this.env.AISSTREAM_API_KEY,
          BoundingBoxes: [BOUNDING_BOX],
          FilterMessageTypes: ['PositionReport'],
        }));
        windowTimer = setTimeout(() => finish(connected), POLL_WINDOW_MS);
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          const vessel = parsePositionReport(msg, now);
          if (vessel) vessels.set(vessel.mmsi, vessel);
        } catch (err) {
          console.error('AIS parse error:', err.message);
        }
      });

      ws.addEventListener('error', (err) => {
        console.error('AISStream error:', err.message || err);
        finish(connected);
      });

      ws.addEventListener('close', () => finish(connected));
    });
  }

  async fetch(request) {
    const now = Date.now();
    const stored = (await this.state.storage.get('vessels')) || [];
    const vessels = new Map(stored.map((v) => [v.mmsi, v]));

    const connected = await this.pollAis(vessels, now);

    for (const mmsi of findStale(vessels, now, STALE_THRESHOLD_MS)) {
      vessels.delete(mmsi);
    }

    await this.state.storage.put('vessels', [...vessels.values()]);

    return new Response(JSON.stringify({
      vessels: [...vessels.values()],
      connected,
      timestamp: now,
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      },
    });
  }
}
