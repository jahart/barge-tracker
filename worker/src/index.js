import { INITIAL_DELAY_MS, nextDelay } from './lib/backoff.js';
import { parsePositionReport } from './lib/vessels.js';

const BOUNDING_BOX = [[39.05, -81.80], [39.42, -81.25]];

// Plain Worker, no Durable Object: each browser connection gets its own
// dedicated upstream AISStream connection, proxied for as long as the
// browser stays connected. Standard Workers bill CPU time only -- holding a
// WebSocket open costs nothing while idle -- so this avoids the Durable
// Objects wall-clock "duration" quota entirely while keeping the API key
// off the client and preserving full real-time fidelity (no polling gaps).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/events') {
      return new Response('Not found', { status: 404 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    relayToClient(server, env);

    return new Response(null, { status: 101, webSocket: client });
  },
};

function relayToClient(server, env) {
  let clientClosed = false;
  server.addEventListener('close', () => { clientClosed = true; });

  const connect = (delay) => {
    if (clientClosed) return;

    if (!env.AISSTREAM_API_KEY) {
      console.warn('AISSTREAM_API_KEY not set — running without live data');
      return;
    }

    const upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');

    upstream.addEventListener('open', () => {
      upstream.send(JSON.stringify({
        APIKey: env.AISSTREAM_API_KEY,
        BoundingBoxes: [BOUNDING_BOX],
        FilterMessageTypes: ['PositionReport'],
      }));
      server.send(JSON.stringify({ type: 'ais-connected' }));
    });

    upstream.addEventListener('message', async (event) => {
      try {
        const text = event.data instanceof Blob ? await event.data.text() : event.data;
        const msg = JSON.parse(text);
        const vessel = parsePositionReport(msg, Date.now());
        if (vessel) server.send(JSON.stringify({ type: 'update', vessel }));
      } catch (err) {
        console.error('AIS parse error:', err.message);
      }
    });

    upstream.addEventListener('error', (err) => {
      console.error('AISStream error:', err.message || err);
    });

    upstream.addEventListener('close', () => {
      if (clientClosed) return;
      const reconnectAt = Date.now() + delay;
      server.send(JSON.stringify({ type: 'ais-reconnecting', reconnectAt }));
      setTimeout(() => connect(nextDelay(delay)), delay);
    });

    server.addEventListener('close', () => { try { upstream.close(); } catch { /* already closed */ } });
  };

  connect(INITIAL_DELAY_MS);
}
