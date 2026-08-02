import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/net/ApiClient.js';
import { Prefetcher } from '../src/boot/Prefetcher.js';
import { SessionCache } from '../src/cache/SessionCache.js';
import { createChatStore, type ChatStoreApi } from '../src/store/ChatStore.js';
import { visibleSessions } from '../src/store/selectors.js';
import type { SessionSummary, SummaryResponse } from '../src/net/types.js';

// The sidebar loads ONE page of sessions and the endpoint is cursor-paginated. These
// tests pin the two halves that were missing: the store keeping the cursor and merging
// an older page without dropping the newer one, and the Prefetcher spending that cursor
// exactly once per request.

function summary(id: string, updatedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    state: 'idle',
    harness: 'claude_code',
    instanceId: 'inst-1',
    type: 'chat',
    purpose: '',
    mode: 'events',
    folderName: '',
    displayName: id,
    agentId: '',
    updatedAt,
    createdAt: updatedAt,
    ...extra,
  };
}

/** A page of `n` sessions whose timestamps descend from `startHour`, newest first. */
function page(prefix: string, n: number, startHour: number): SessionSummary[] {
  return Array.from({ length: n }, (_, i) =>
    summary(`${prefix}-${i}`, `2026-08-0${1} ${String(startHour - i).padStart(2, '0')}:00:00`),
  );
}

/** A fetch that answers /sessions/summary from a queue of responses and records ONLY
 *  the summary URLs. `prime()` also fires recent-bundle and validators off the same
 *  fetch; counting those would make the request assertions below meaningless. */
function summaryFetch(responses: SummaryResponse[], seen: string[]): typeof fetch {
  let i = 0;
  return (async (url: string) => {
    const href = String(url);
    const isSummary = href.includes('/sessions/summary');
    let body: unknown = {};
    if (isSummary) {
      seen.push(href);
      body = responses[Math.min(i, responses.length - 1)];
      i += 1;
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function wire(responses: SummaryResponse[]): {
  store: ChatStoreApi;
  prefetcher: Prefetcher;
  seen: string[];
} {
  const seen: string[] = [];
  const store = createChatStore();
  const api = new ApiClient({ fetch: summaryFetch(responses, seen), basePath: '/api/bridge' });
  // Cache disabled: these tests are about the network window, and an enabled cache
  // would need a real IndexedDB.
  const prefetcher = new Prefetcher({ store, api, cache: new SessionCache(false), sessionsPerPage: 3 });
  return { store, prefetcher, seen };
}

describe('ChatStore — the older-sessions window', () => {
  it('starts with no cursor, so a sidebar that never fetched claims nothing about more', () => {
    const store = createChatStore();
    expect(store.getState().olderSessionsCursor).toBeNull();
    expect(store.getState().olderSessionsLoading).toBe(false);
  });

  it('setSessions re-anchors the cursor, and defaults it to null when none is given', () => {
    const store = createChatStore();
    const { setSessions } = store.getState().actions;

    setSessions(page('a', 2, 12), 'cursor-1');
    expect(store.getState().olderSessionsCursor).toBe('cursor-1');

    // The cache paint passes no cursor. It must not leave a stale one behind, or the
    // sidebar would offer to page from a boundary the network never confirmed.
    setSessions(page('a', 2, 12));
    expect(store.getState().olderSessionsCursor).toBeNull();
  });

  it('appendOlderSessions merges — the newer page survives, and both are visible', () => {
    const store = createChatStore();
    const { setSessions, appendOlderSessions } = store.getState().actions;

    setSessions(page('new', 3, 12), 'cursor-1');
    appendOlderSessions(page('old', 3, 9), 'cursor-2');

    const sessions = store.getState().sessions;
    expect(sessions.size).toBe(6);
    expect(sessions.has('new-0')).toBe(true);
    expect(sessions.has('old-0')).toBe(true);
    expect(store.getState().olderSessionsCursor).toBe('cursor-2');

    // And they sort into one newest-first run, not two appended blocks.
    const ids = visibleSessions(store.getState())[0]!.sessions.map((s) => s.sessionId);
    expect(ids.slice(0, 3)).toEqual(['new-0', 'new-1', 'new-2']);
    expect(ids.slice(3)).toEqual(['old-0', 'old-1', 'old-2']);
  });

  it('a null cursor on the last page ends the paging, so the sidebar stops offering more', () => {
    const store = createChatStore();
    store.getState().actions.setSessions(page('a', 3, 12), 'cursor-1');
    store.getState().actions.appendOlderSessions(page('b', 1, 9), null);
    expect(store.getState().olderSessionsCursor).toBeNull();
  });

  it('keeps a row the SSE updated while the page was in flight', () => {
    const store = createChatStore();
    const { setSessions, upsertSession, appendOlderSessions } = store.getState().actions;

    setSessions([], 'cursor-1');
    // A session arrives live and is marked running.
    upsertSession(summary('s-1', '2026-08-01 12:00:00', { state: 'running' }));
    // The older page carries the same session, as the server saw it before the update.
    appendOlderSessions([summary('s-1', '2026-08-01 11:00:00', { state: 'idle' })], null);

    expect(store.getState().sessions.get('s-1')!.state).toBe('running');
  });

  it('a later setSessions resets the window, dropping older pages AND their cursor together', () => {
    const store = createChatStore();
    const { setSessions, appendOlderSessions } = store.getState().actions;
    setSessions(page('new', 3, 12), 'cursor-1');
    appendOlderSessions(page('old', 3, 9), 'cursor-2');

    setSessions(page('new', 3, 12), 'cursor-1');
    expect(store.getState().sessions.size).toBe(3);
    // The pair must move together: a window reset that kept cursor-2 would page from a
    // boundary below sessions no longer loaded, leaving a hole in the middle.
    expect(store.getState().olderSessionsCursor).toBe('cursor-1');
  });
});

describe('Prefetcher — spending the cursor', () => {
  it('prime carries the response cursor into the store', async () => {
    const { store, prefetcher } = wire([
      { sessions: page('a', 3, 12), next: 'cursor-1', revision: 'r1' },
    ]);
    await prefetcher.prime();
    expect(store.getState().sessions.size).toBe(3);
    expect(store.getState().olderSessionsCursor).toBe('cursor-1');
  });

  it('a short first page leaves no cursor — there is nothing older to offer', async () => {
    const { store, prefetcher } = wire([
      { sessions: page('a', 2, 12), next: null, revision: 'r1' },
    ]);
    await prefetcher.prime();
    expect(store.getState().olderSessionsCursor).toBeNull();
  });

  it('loadOlderSessions asks for the page BEFORE the cursor and merges it', async () => {
    const { store, prefetcher, seen } = wire([
      { sessions: page('a', 3, 12), next: 'cursor-1', revision: 'r1' },
      { sessions: page('b', 3, 9), next: 'cursor-2', revision: 'r1' },
    ]);
    await prefetcher.prime();
    await prefetcher.loadOlderSessions();

    expect(store.getState().sessions.size).toBe(6);
    expect(store.getState().olderSessionsCursor).toBe('cursor-2');
    expect(seen[1]).toContain('before=cursor-1');
    // The page size must ride along too — omitting it would silently fall back to the
    // server's own default and page a different width than the boot page.
    expect(seen[1]).toContain('limit=3');
  });

  it('is a no-op with no cursor, so a fully-loaded list never re-requests page one', async () => {
    const { prefetcher, seen } = wire([
      { sessions: page('a', 2, 12), next: null, revision: 'r1' },
    ]);
    await prefetcher.prime();
    await prefetcher.loadOlderSessions();
    expect(seen).toHaveLength(1);
  });

  it('two calls in one tick make ONE request — the in-flight guard is set before the fetch', async () => {
    const { prefetcher, seen } = wire([
      { sessions: page('a', 3, 12), next: 'cursor-1', revision: 'r1' },
      { sessions: page('b', 3, 9), next: 'cursor-2', revision: 'r1' },
    ]);
    await prefetcher.prime();
    // A scroll event and a button click in the same tick. Neither awaits the other.
    await Promise.all([prefetcher.loadOlderSessions(), prefetcher.loadOlderSessions()]);
    expect(seen.filter((u) => u.includes('before='))).toHaveLength(1);
  });

  it('a failed page clears the in-flight flag and KEEPS the cursor, so the retry is still offered', async () => {
    const seen: string[] = [];
    const store = createChatStore();
    let call = 0;
    const fetchFn = (async (url: string) => {
      const href = String(url);
      if (!href.includes('/sessions/summary')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
          text: async () => '',
        } as unknown as Response;
      }
      seen.push(href);
      call += 1;
      if (call === 1) {
        const body: SummaryResponse = { sessions: page('a', 3, 12), next: 'cursor-1', revision: 'r1' };
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => body,
          text: async () => '',
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
        text: async () => 'boom',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const api = new ApiClient({ fetch: fetchFn, basePath: '/api/bridge' });
    const prefetcher = new Prefetcher({
      store,
      api,
      cache: new SessionCache(false),
      sessionsPerPage: 3,
    });

    await prefetcher.prime();
    await prefetcher.loadOlderSessions();

    expect(store.getState().olderSessionsLoading).toBe(false);
    expect(store.getState().olderSessionsCursor).toBe('cursor-1');
    expect(store.getState().sessions.size).toBe(3);

    // And the affordance still works once the server recovers.
    await prefetcher.loadOlderSessions();
    expect(seen.filter((u) => u.includes('before=cursor-1'))).toHaveLength(2);
  });
});

describe('Prefetcher — the cache paint is bounded to one page', () => {
  it('paints at most one page from the cache, so the sidebar cannot shrink when page one lands', async () => {
    const store = createChatStore();
    const api = new ApiClient({
      fetch: summaryFetch([{ sessions: [], next: null, revision: 'r1' }], []),
      basePath: '/api/bridge',
    });
    // The cache's list store is append-only (the SyncEngine writes every session it
    // sees live and nothing evicts a list row), so it can hold far more than a page.
    const cached = page('c', 10, 20);
    const cache = {
      isEnabled: true,
      hydrate: async () => ({ list: cached, turns: new Map(), validators: new Map() }),
    } as unknown as SessionCache;
    const prefetcher = new Prefetcher({ store, api, cache, sessionsPerPage: 3 });

    await prefetcher.hydrateFromCache();

    expect(store.getState().sessions.size).toBe(3);
    // The newest three, because the cached list is already newest-first.
    expect([...store.getState().sessions.keys()]).toEqual(['c-0', 'c-1', 'c-2']);
  });
});
