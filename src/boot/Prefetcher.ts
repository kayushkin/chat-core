import type { ApiClient } from '../net/ApiClient.js';
import type { SessionCache } from '../cache/SessionCache.js';
import { enforceCacheBound } from '../cache/evict.js';
import type { ChatStoreApi } from '../store/ChatStore.js';

// Boot sequence (§6) + hover/idle prefetch. The boot order is the whole latency
// story: hydrate from cache and PAINT first (0 network), THEN fan out the three
// parallel reads, THEN background-page the rest of the list. Hover/idle prefetch
// warms a cold session before the click so a select() is a Map read.

export interface PrefetcherConfig {
  store: ChatStoreApi;
  api: ApiClient;
  cache: SessionCache;
  recentN?: number;
  turnsPerBundle?: number;
  cacheLimit?: number;
}

export class Prefetcher {
  private readonly store: ChatStoreApi;
  private readonly api: ApiClient;
  private readonly cache: SessionCache;
  private readonly recentN: number;
  private readonly turnsPerBundle: number;
  private readonly cacheLimit: number;
  private readonly inFlight = new Set<string>();

  constructor(config: PrefetcherConfig) {
    this.store = config.store;
    this.api = config.api;
    this.cache = config.cache;
    this.recentN = config.recentN ?? 20;
    this.turnsPerBundle = config.turnsPerBundle ?? 30;
    this.cacheLimit = config.cacheLimit ?? 50;
  }

  /** Step 1: hydrate the store from IndexedDB and paint. 0 network. Resolves
   *  once the cached list + turns are in the store (or immediately if disabled). */
  async hydrateFromCache(): Promise<void> {
    if (!this.cache.isEnabled) return;
    const actions = this.store.getState().actions;
    try {
      const hydrated = await this.cache.hydrate();
      if (hydrated.list.length > 0) actions.setSessions(hydrated.list);
      for (const [id, model] of hydrated.turns) actions.setTurns(id, model);
    } catch {
      // Cold cache / disabled — the network paint below covers it.
    }
  }

  /** Step 2: the three parallel reads. Summary + recent-bundle + validators land
   *  and fill the hot store. Runs after (or racing) the cache paint. */
  async prime(): Promise<void> {
    const actions = this.store.getState().actions;
    actions.setListLoading(this.store.getState().sessions.size === 0);

    const cachedIds = [...this.store.getState().turnsBySession.keys()];

    const summaryP = this.api
      .getSummary({ limit: 100 })
      .then((resp) => {
        actions.setSessions(resp.sessions);
        void this.cache.putList(resp.sessions);
        return resp;
      })
      .catch(() => null);

    const bundleP = this.api
      .getRecentBundle({ n: this.recentN, turns: this.turnsPerBundle })
      .then((bundle) => {
        for (const id of Object.keys(bundle)) {
          const entry = bundle[id];
          if (!entry) continue;
          actions.upsertSession(entry.summary);
          actions.setTurns(id, entry.model);
          void this.cache.putSummary(entry.summary);
          void this.cache.putTurns(entry.model);
        }
        return bundle;
      })
      .catch(() => null);

    const validatorsP =
      cachedIds.length > 0
        ? this.api.getValidators(cachedIds).catch(() => null)
        : Promise.resolve(null);

    await Promise.all([summaryP, bundleP, validatorsP]);

    if (this.cache.isEnabled) void enforceCacheBound(this.cache, this.cacheLimit);
  }

  /** Full boot: cache paint → parallel prime. */
  async boot(): Promise<void> {
    await this.hydrateFromCache();
    await this.prime();
  }

  /** Hover/idle hint: warm a cold session so the next click is a Map read.
   *  No-op if already warm or a fetch is already in flight. */
  prefetch(sessionId: string): void {
    if (!sessionId) return;
    if (this.store.getState().turnsBySession.has(sessionId)) return;
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    void this.warm(sessionId);
  }

  private async warm(sessionId: string): Promise<void> {
    try {
      const resp = await this.api.getMessages(sessionId, { limit: this.turnsPerBundle });
      // Re-check: a live select() may have already warmed it.
      if (!this.store.getState().turnsBySession.has(sessionId)) {
        this.store.getState().actions.setTurns(sessionId, resp.model);
      }
      void this.cache.putTurns(resp.model);
    } catch {
      // Non-fatal — the click path will fetch on demand.
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}
