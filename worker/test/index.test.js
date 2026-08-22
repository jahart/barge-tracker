import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';

describe('worker fetch routing', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await worker.fetch(new Request('https://relay.example/nope'), {});
    expect(res.status).toBe(404);
  });

  it('returns 426 for GET /events without a WebSocket upgrade', async () => {
    const res = await worker.fetch(new Request('https://relay.example/events'), {});
    expect(res.status).toBe(426);
  });
});
