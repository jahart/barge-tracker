import { AisRelay } from './AisRelay.js';

export { AisRelay };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/events' && request.method === 'GET') {
      // Renamed from 'ohio-river' to force a fresh Durable Object instance
      // after a key rotation -- a running instance keeps using the env/secret
      // it captured at construction time, so rotating the secret alone
      // doesn't make an already-running instance pick up the new key.
      const id = env.AIS_RELAY.idFromName('ohio-river-v2');
      const stub = env.AIS_RELAY.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
