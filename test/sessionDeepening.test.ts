import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/net/ApiClient.js';
import { Prefetcher } from '../src/boot/Prefetcher.js';
import { SessionCache } from '../src/cache/SessionCache.js';
import { createChatStore, type ChatStoreApi } from '../src/store/ChatStore.js';
import type { SessionSummary, SummaryResponse } from '../src/net/types.js';

// The sidebar's window used to be exactly one page of the newest sessions, whatever
// they were. On this box that page is ~8% sessions the user opened themselves and
// ~92% machine traffic, so the list was mostly autoworkers and reaching 50 real
// sessions meant paging 677 rows deep.
//
// Two changes fix it and these tests pin both: the boot page is FILTERED server-side
// by the restored chip selection, and a background loop keeps paging behind the
// painted list up to a budget, filtered stream first and unfiltered after it.

function summary(id: string, updatedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    state: 'idle',
    harness: 'claude_code',
    instanceId: 'inst-1',
    type: 'interactive',
    purpose: 'chat',
    mode: 'events',
    folderName: '',
    displayName: id,
    agentId: '',
    updatedAt,
    createdAt: updatedAt,
    ...extra,
  };
}

/** A page of `n` uniquely-named sessions, so merging pages grows the window rather
 *  than overwriting it. */
function page(prefix: string, n: number): SessionSummary[] {
  return Array.from({ length: n }, (_, i) =>
    summary(`${prefix}-${i}`, `2026-08-01 12:00:0${i % 10}`),
  );
}

/** Answers /sessions/summary from a queue and records the summary URLs in order.
 *  Anything else off the same fetch (recent-bundle, validators, folders) answers
 *  empty and is deliberately NOT recorded — counting it would drown the assertions. */
function summaryFetch(responses: SummaryResponse[], seen: string[]): typeof fetch {
  let i = 0;
  return (async (url: string) => {
    const href = String(url);
    let body: unknown = {};
    if (href.includes('/sessions/summary')) {
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

function wire(
  responses: SummaryResponse[],
  opts: { budget?: number; perPage?: number } = {},
): { store: ChatStoreApi; prefetcher: Prefetcher; seen: string[] } {
  const seen: string[] = [];
  const store = createChatStore();
  const api = new ApiClient({ fetch: summaryFetch(responses, seen), basePath: '/api/bridge' });
  const prefetcher = new Prefetcher({
    store,
    api,
    // Cache off: these tests are about the network window, and an enabled cache
    // would need a real IndexedDB.
    cache: new SessionCache(false),
    sessionsPerPage: opts.perPage ?? 3,
    backgroundSessionBudget: opts.budget ?? 0,
  });
  return { store, prefetcher, seen };
}

/** The axes a summary URL asked for, as `axis=value` pairs — what the server will
 *  actually filter on, rather than what the caller meant to send. */
function axesOf(url: string): string[] {
  const query = new URLSearchParams(url.split('?')[1] ?? '');
  const out: string[] = [];
  for (const [key, value] of query.entries()) {
    if (key !== 'limit' && key !== 'before') out.push(`${key}=${value}`);
  }
  return out.sort();
}

describe('the boot page is filtered server-side', () => {
  it('sends the restored chip selection, so the first page is relevant and not merely recent', async () => {
    const { store, prefetcher, seen } = wire([{ sessions: page('a', 3), next: null, revision: 'r' }]);
    store.getState().actions.setFilter({ type: ['interactive', 'herald'] });

    await prefetcher.prime();

    expect(axesOf(seen[0])).toEqual(['type=herald', 'type=interactive']);
  });

  it('repeats a parameter per value rather than joining on commas', async () => {
    // A purpose on this box reads "dashv2 browser verification + A/B perf"; nothing
    // stops one holding a comma, and a joined list would be cut in half by the split.
    const { store, prefetcher, seen } = wire([{ sessions: [], next: null, revision: 'r' }]);
    store.getState().actions.setFilter({ purpose: ['a,b', 'c'] });

    await prefetcher.prime();

    const query = seen[0].split('?')[1] ?? '';
    expect(query).toContain('purpose=a%2Cb');
    expect(query).toContain('purpose=c');
  });

  it('sends no axes at all when nothing is selected, so an unfiltered boot is unchanged', async () => {
    const { prefetcher, seen } = wire([{ sessions: page('a', 3), next: null, revision: 'r' }]);
    await prefetcher.prime();
    expect(axesOf(seen[0])).toEqual([]);
  });
});

describe('background deepening', () => {
  it('keeps paging behind the painted list until the window reaches the budget', async () => {
    const { store, prefetcher } = wire(
      [
        { sessions: page('p1', 3), next: 'c1', revision: 'r' },
        { sessions: page('p2', 3), next: 'c2', revision: 'r' },
        { sessions: page('p3', 3), next: 'c3', revision: 'r' },
        { sessions: page('p4', 3), next: 'c4', revision: 'r' },
      ],
      { budget: 8 },
    );

    await prefetcher.prime();
    await prefetcher.deepenInBackground();

    // Pages of 3 against a budget of 8: it stops at the first page that reaches it,
    // rather than truncating a page to land on the number exactly.
    expect(store.getState().sessions.size).toBe(9);
  });

  it('leaves the cursor in place at the budget, so the button can still take over', async () => {
    const { store, prefetcher } = wire(
      [
        { sessions: page('p1', 3), next: 'c1', revision: 'r' },
        { sessions: page('p2', 3), next: 'c2', revision: 'r' },
        { sessions: page('p3', 3), next: 'c3', revision: 'r' },
      ],
      { budget: 5 },
    );

    await prefetcher.prime();
    await prefetcher.deepenInBackground();
    const atBudget = store.getState().sessions.size;
    expect(store.getState().olderSessionsCursor).not.toBeNull();

    // The button resumes exactly where deepening stopped.
    await prefetcher.loadOlderSessions();
    expect(store.getState().sessions.size).toBeGreaterThan(atBudget);
  });

  it('is off entirely at budget 0 — one page, as before', async () => {
    const { store, prefetcher, seen } = wire(
      [{ sessions: page('p1', 3), next: 'c1', revision: 'r' }],
      { budget: 0 },
    );

    await prefetcher.boot();

    expect(seen.length).toBe(1);
    expect(store.getState().sessions.size).toBe(3);
  });

  it('stops when asked, and the page already in flight is the last one', async () => {
    const { store, prefetcher } = wire(
      [
        { sessions: page('p1', 3), next: 'c1', revision: 'r' },
        { sessions: page('p2', 3), next: 'c2', revision: 'r' },
        { sessions: page('p3', 3), next: 'c3', revision: 'r' },
      ],
      { budget: 100 },
    );

    await prefetcher.prime();
    prefetcher.stopBackgroundDeepening();
    // A stop that a later call silently cleared would be no stop at all, so this
    // asserts the loop refuses to start rather than that it merely ends early.
    const deepen = prefetcher.deepenInBackground();
    prefetcher.stopBackgroundDeepening();
    await deepen;

    expect(store.getState().sessions.size).toBeLessThanOrEqual(6);
  });
});

describe('the filtered → unfiltered handover', () => {
  it('walks the filtered stream first and the unfiltered one after it', async () => {
    const { store, prefetcher, seen } = wire(
      [
        // Boot: filtered page one, more to come.
        { sessions: page('f1', 3), next: 'fc1', revision: 'r' },
        // Filtered page two exhausts that stream.
        { sessions: page('f2', 3), next: null, revision: 'r' },
        // The handover's first unfiltered page.
        { sessions: page('u1', 3), next: 'uc1', revision: 'r' },
        { sessions: page('u2', 3), next: 'uc2', revision: 'r' },
      ],
      { budget: 11 },
    );
    store.getState().actions.setFilter({ type: ['interactive'] });

    await prefetcher.prime();
    await prefetcher.deepenInBackground();

    // Boot and the second page carry the filter; everything after the handover
    // drops it, which is what keeps the facet chips describing more than the
    // filtered slice.
    expect(axesOf(seen[0])).toEqual(['type=interactive']);
    expect(axesOf(seen[1])).toEqual(['type=interactive']);
    expect(axesOf(seen[2])).toEqual([]);
    expect(axesOf(seen[3])).toEqual([]);
  });

  it('never parks the cursor on null mid-handover, so the button cannot blink out', async () => {
    // The blink-out case is a filtered stream that runs out having HAD pages: the
    // sidebar is showing the button off `fc1` when the page that empties the stream
    // lands. Writing null there and switching on the next call would hide the button
    // for a whole round trip. The handover happens inside that one call instead, so
    // the cursor steps fc1 → uc1 and never through null.
    const cursors: (string | null)[] = [];
    const { store, prefetcher } = wire(
      [
        { sessions: page('f1', 3), next: 'fc1', revision: 'r' },
        { sessions: page('f2', 3), next: null, revision: 'r' }, // filtered stream ends here
        { sessions: page('u1', 3), next: 'uc1', revision: 'r' }, // handover, same call
      ],
      { budget: 8 },
    );
    store.getState().actions.setFilter({ type: ['interactive'] });
    // Record CHANGES, not every store notification — the store notifies on drafts,
    // loading flags and folder loads too, and counting those would say nothing about
    // the cursor.
    store.subscribe((s) => {
      if (cursors[cursors.length - 1] !== s.olderSessionsCursor) {
        cursors.push(s.olderSessionsCursor);
      }
    });

    await prefetcher.prime();
    await prefetcher.deepenInBackground();

    expect(store.getState().olderSessionsCursor).toBe('uc1');
    // The leading null is the store's own starting state, before any page landed —
    // the sidebar draws no button then and is right not to. The claim under test is
    // that once a cursor EXISTS it never goes back to null.
    const firstCursor = cursors.findIndex((c) => c !== null);
    expect(cursors.slice(firstCursor)).toEqual(['fc1', 'uc1']);
  });

  it('skips the handover when no filter is set, rather than re-fetching page one', async () => {
    const { prefetcher, seen } = wire(
      [
        { sessions: page('p1', 3), next: 'c1', revision: 'r' },
        { sessions: page('p2', 3), next: null, revision: 'r' },
      ],
      { budget: 100 },
    );

    await prefetcher.prime();
    await prefetcher.deepenInBackground();

    // Two pages, and no third request re-opening an "unfiltered" stream that was
    // never distinct from the one just walked.
    expect(seen.length).toBe(2);
  });
});
