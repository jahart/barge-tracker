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
