import { AisRelay } from './AisRelay.js';

export { AisRelay };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/events' && request.method === 'GET') {
      const id = env.AIS_RELAY.idFromName('ohio-river');
      const stub = env.AIS_RELAY.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
