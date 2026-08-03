import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SessionCache } from '../src/cache/SessionCache.js';
import { SyncEngine } from '../src/sync/SyncEngine.js';
import { Prefetcher } from '../src/boot/Prefetcher.js';
import { createChatStore } from '../src/store/ChatStore.js';
import type { ApiClient } from '../src/net/ApiClient.js';
import type { SessionSummary } from '../src/net/types.js';

// The policy lives in `evict.ts` and is covered by `listCacheBound.test.ts`. This
// file covers the other half — that the two live callers actually run it, and run
// it with the PAGE SIZE rather than a constant. A bound that trims below the page
// size is worse than no bound: it drops rows the very next cold paint wanted.

function summary(id: string, updatedAt: string): SessionSummary {
  return {
    sessionId: id,
    state: 'idle',
    harness: 'claudecode',
    instanceId: 'inst1',
    type: 'interactive',
    purpose: 'chat',
    mode: 'events',
    folderName: '',
    displayName: id,
    agentId: '',
    updatedAt,
    createdAt: updatedAt,
  };
}

/** `n` rows, ids running opposite to age (see listCacheBound.test.ts). */
function aged(n: number): SessionSummary[] {
  const base = Date.parse('2026-01-01T00:00:00-07:00');
  return Array.from({ length: n }, (_, i) =>
    summary(`br_${String(n - 1 - i).padStart(4, '0')}`, new Date(base + i * 60_000).toISOString()),
  );
}

/** An ApiClient that answers every boot/sweep read with nothing. */
function quietApi(): ApiClient {
  return {
    getSummary: async () => ({ sessions: [], next: null }),
    getRecentBundle: async () => ({}),
    getValidators: async () => ({}),
    listFolders: async () => [],
  } as unknown as ApiClient;
}

describe('the list bound is wired to both callers, at the page size', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('Prefetcher.prime trims the list store it just grew', async () => {
    const cache = new SessionCache(true);
    await cache.putList(aged(400));

    const prefetcher = new Prefetcher({
      store: createChatStore(),
      api: quietApi(),
      cache,
      sessionsPerPage: 100,
    });
    await prefetcher.prime();
    // `prime` fires the bound without awaiting it — the boot path must not block
    // on housekeeping — so settle the microtasks it queued.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cache.getList()).toHaveLength(100);
    await cache.close();
  });

  it('Prefetcher keeps a LARGER configured page whole', async () => {
    // The regression this pins: bounding to the 100-row default would trim 100
    // rows off a host that asked for a 200-row sidebar page, and the cold paint
    // would come back half-width.
    const cache = new SessionCache(true);
    await cache.putList(aged(400));

    const prefetcher = new Prefetcher({
      store: createChatStore(),
      api: quietApi(),
      cache,
      sessionsPerPage: 200,
    });
    await prefetcher.prime();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cache.getList()).toHaveLength(200);
    await cache.close();
  });

  it('the SyncEngine sweep trims it too, at its own configured page size', async () => {
    // The sweep matters more than boot: a tab left open all day is where the
    // append-only growth actually happened.
    const cache = new SessionCache(true);
    await cache.putList(aged(400));

    const engine = new SyncEngine({
      store: createChatStore(),
      api: quietApi(),
      cache,
      sessionsPerPage: 200,
    });
    await engine.sweepValidators();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cache.getList()).toHaveLength(200);
    await cache.close();
  });

  it('the sweep trims even when the network read fails', async () => {
    // The bound touches only IndexedDB, so a transient `getValidators` failure is
    // no reason to skip it. It used to sit past that `catch { return }`.
    const cache = new SessionCache(true);
    await cache.putList(aged(400));
    const store = createChatStore();
    store.getState().actions.setTurns('br_0399', {
      sessionId: 'br_0399',
      turns: [],
      entries: {},
      validator: { maxEventId: 1, eventCount: 1, updatedAt: '' },
      more: false,
    });
    const api = {
      getValidators: async () => {
        throw new Error('network hiccup');
      },
    } as unknown as ApiClient;

    const engine = new SyncEngine({ store, api, cache, sessionsPerPage: 100 });
    await engine.sweepValidators();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cache.getList()).toHaveLength(100);
    await cache.close();
  });

  it('a sweep with no configured page size falls back to the default bound', async () => {
    const cache = new SessionCache(true);
    await cache.putList(aged(400));

    const engine = new SyncEngine({ store: createChatStore(), api: quietApi(), cache });
    await engine.sweepValidators();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cache.getList()).toHaveLength(100);
    await cache.close();
  });
});
