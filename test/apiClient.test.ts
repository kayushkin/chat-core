import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/net/ApiClient.js';

interface FakeRes {
  ok: boolean;
  status: number;
  statusText: string;
  jsonBody?: unknown;
  textBody?: string;
}

function fakeFetch(res: FakeRes, record?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    record?.(String(url), init);
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      json: async () => res.jsonBody ?? {},
      text: async () => res.textBody ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('ApiClient.interrupt — fails loud', () => {
  it('throws (does NOT swallow) on a 409 "nothing was stopped"', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({ ok: false, status: 409, statusText: 'Conflict', textBody: 'nothing was stopped' }),
      basePath: '/api/bridge',
    });
    // A 409 while a tool holds the turn must surface as a thrown error — never a
    // resolved/fake-idle result.
    await expect(api.interrupt('br_1')).rejects.toThrow(/409/);
  });

  it('POSTs to /sessions/{id}/interrupt and resolves on 2xx', async () => {
    const seen: string[] = [];
    const api = new ApiClient({
      fetch: fakeFetch({ ok: true, status: 200, statusText: 'OK', jsonBody: {} }, (u) => seen.push(u)),
      basePath: '/api/bridge',
    });
    await expect(api.interrupt('br_1')).resolves.toBeDefined();
    expect(seen[0]).toBe('/api/bridge/sessions/br_1/interrupt');
  });
});

describe('ApiClient.search', () => {
  it('GETs /sessions/search?q= and returns the hit ids', async () => {
    const seen: string[] = [];
    const api = new ApiClient({
      fetch: fakeFetch({ ok: true, status: 200, statusText: 'OK', jsonBody: { sessionIds: ['br_2', 'br_9'] } }, (u) =>
        seen.push(u),
      ),
      basePath: '/api/bridge',
    });
    const r = await api.search('deploy sync');
    expect(r.sessionIds).toEqual(['br_2', 'br_9']);
    expect(seen[0]).toContain('/sessions/search?q=deploy');
  });

  it('throws on a non-2xx search response', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({ ok: false, status: 500, statusText: 'Server Error' }),
      basePath: '/api/bridge',
    });
    await expect(api.search('x')).rejects.toThrow(/500/);
  });
});
