import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';

describe('worker fetch routing', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await worker.fetch(new Request('https://relay.example/nope'), {});
    expect(res.status).toBe(404);
  });

  it('forwards GET /events to the AisRelay Durable Object stub', async () => {
    const stubResponse = new Response('ok');
    const stub = { fetch: vi.fn().mockResolvedValue(stubResponse) };
    const env = {
      AIS_RELAY: {
        idFromName: vi.fn().mockReturnValue('id-ohio-river'),
        get: vi.fn().mockReturnValue(stub),
      },
    };
    const request = new Request('https://relay.example/events');
    const res = await worker.fetch(request, env);

    expect(env.AIS_RELAY.idFromName).toHaveBeenCalledWith('ohio-river-v2');
    expect(env.AIS_RELAY.get).toHaveBeenCalledWith('id-ohio-river');
    expect(stub.fetch).toHaveBeenCalledWith(request);
    expect(res).toBe(stubResponse);
  });
});
