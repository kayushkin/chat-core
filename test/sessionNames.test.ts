import { describe, expect, it, beforeEach } from 'vitest';
import { ApiClient } from '../src/net/ApiClient.js';

// The id lookup on `GET /sessions/summary`, and why it is not a filter chip.
//
// Every other surface in this package already holds a `SessionSummary` — a sidebar row
// renders one, a header renders one — so none of them ever needed to turn an id into a
// name. The cross-session signals inbox is the first that does: a signal carries
// `session_id` and nothing else.
//
// Paging cannot answer it. The sidebar loads a newest-first prefix, and a session that
// asked something and then went quiet sinks out of that prefix while its question stays
// open — which is exactly the case the inbox exists for. Measured on this host: of the
// 17 sessions holding an open chat signal, 11 were nowhere in the sidebar's first page.

const BASE = '/api/bridge';

interface Call {
  url: string;
}

function client(): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push({ url: String(url) });
    return {
      ok: true,
      status: 200,
      statusText: '200',
      json: async () => ({ sessions: [], next: null, revision: 'r' }),
      text: async () => '{}',
    } as unknown as Response;
  };
  return { api: new ApiClient({ fetch: fetchFn as unknown as typeof fetch, basePath: BASE }), calls };
}

describe('looking sessions up by id', () => {
  let ctx: ReturnType<typeof client>;
  beforeEach(() => {
    ctx = client();
  });

  it('sends one repeated parameter per id, in one request', async () => {
    await ctx.api.getSummary({ sessionIds: ['br_a', 'br_b', 'br_c'] });

    expect(ctx.calls).toHaveLength(1);
    const params = new URL(ctx.calls[0]!.url, 'http://x').searchParams;
    expect(params.getAll('session_id')).toEqual(['br_a', 'br_b', 'br_c']);
  });

  it('never comma-joins them', async () => {
    // Repeated, not joined, for the same reason the filter axes are: the server splits
    // on commas too, but a joined list is one value that has to survive a round trip
    // intact, and the axes beside it are free-form strings from the sessions table.
    // One shape for both keeps the endpoint from having two parsers.
    await ctx.api.getSummary({ sessionIds: ['br_a', 'br_b'] });
    expect(ctx.calls[0]!.url).not.toContain('br_a,br_b');
  });

  it('is not a filter axis — it composes with them and with paging', async () => {
    await ctx.api.getSummary({
      sessionIds: ['br_a'],
      filter: { harness: ['claude_code'] },
      limit: 1,
    });
    const params = new URL(ctx.calls[0]!.url, 'http://x').searchParams;
    expect(params.getAll('session_id')).toEqual(['br_a']);
    expect(params.getAll('harness')).toEqual(['claude_code']);
    expect(params.get('limit')).toBe('1');
  });

  it('sends nothing at all when no ids are asked for', async () => {
    // An empty `session_id` would narrow to nothing on a server that treats
    // present-but-empty as a constraint, turning an ordinary sidebar page into a blank
    // one. Absent has to stay absent.
    await ctx.api.getSummary({ limit: 20 });
    expect(ctx.calls[0]!.url).not.toContain('session_id');

    await ctx.api.getSummary({ sessionIds: [], limit: 20 });
    expect(ctx.calls[1]!.url).not.toContain('session_id');
  });
});
