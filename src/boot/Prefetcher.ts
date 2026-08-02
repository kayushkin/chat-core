import type { ApiClient } from '../net/ApiClient.js';
import type { SessionCache } from '../cache/SessionCache.js';
import { enforceCacheBound } from '../cache/evict.js';
import type { ChatStoreApi } from '../store/ChatStore.js';

// Boot sequence (§6) + hover/idle prefetch. The boot order is the whole latency
// story: hydrate from cache and PAINT first (0 network), THEN fan out the three
// parallel reads. Hover/idle prefetch warms a cold session before the click so a
// select() is a Map read.
//
// Boot deliberately loads ONE page of sessions and stops. Pages past the first are
// pulled by `loadOlderSessions()` when the user scrolls to the end of the sidebar —
// this box has over 5,000 sessions, and background-paging them all is the unbounded
// list load the whole rewrite exists to kill.

export interface PrefetcherConfig {
  store: ChatStoreApi;
  api: ApiClient;
  cache: SessionCache;
  recentN?: number;
  turnsPerBundle?: number;
  cacheLimit?: number;
  /** Sessions per sidebar page, for the boot page and every older page after it. */
  sessionsPerPage?: number;
}

export class Prefetcher {
  /** Default sessions per sidebar page. Mirrors the summary endpoint's own default
   *  so a boot that names no page size asks for exactly what the server would give. */
  static readonly DEFAULT_SESSIONS_PER_PAGE = 100;

  private readonly store: ChatStoreApi;
  private readonly api: ApiClient;
  private readonly cache: SessionCache;
  private readonly recentN: number;
  private readonly turnsPerBundle: number;
  private readonly cacheLimit: number;
  private readonly sessionsPerPage: number;
  private readonly inFlight = new Set<string>();

  constructor(config: PrefetcherConfig) {
    this.store = config.store;
    this.api = config.api;
    this.cache = config.cache;
    this.recentN = config.recentN ?? 20;
    this.turnsPerBundle = config.turnsPerBundle ?? 30;
    this.cacheLimit = config.cacheLimit ?? 50;
    this.sessionsPerPage = config.sessionsPerPage ?? Prefetcher.DEFAULT_SESSIONS_PER_PAGE;
  }

  /** Step 1: hydrate the store from IndexedDB and paint. 0 network. Resolves
   *  once the cached list + turns are in the store (or immediately if disabled). */
  async hydrateFromCache(): Promise<void> {
    if (!this.cache.isEnabled) return;
    const actions = this.store.getState().actions;
    try {
      const hydrated = await this.cache.hydrate();
      // Bounded to one page. The cache's list store is append-only — every session
      // ever seen live is written to it by the SyncEngine and nothing evicts a list
      // row — so an unbounded paint would show hundreds of rows and then SHRINK back
      // to one page the moment the network's first page replaced them. The cached
      // list is sorted newest-first, so the head of it is the same window page one
      // is about to confirm.
      const painted = hydrated.list.slice(0, this.sessionsPerPage);
      if (painted.length > 0) actions.setSessions(painted);
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
      .getSummary({ limit: this.sessionsPerPage })
      .then((resp) => {
        // `resp.next` is the only truncation signal the endpoint offers (it carries no
        // total), so carrying it into the store is what lets the sidebar say "there is
        // more" and page down. Dropping it was the whole 100-session cap.
        actions.setSessions(resp.sessions, resp.next ?? null);
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

  /** Pull the next page of OLDER sessions and merge it into the sidebar's window.
   *
   *  No-op when the store holds no cursor (the server said there is nothing older) or
   *  when a page is already in flight — the in-flight flag is set synchronously before
   *  the fetch, so a scroll event and a button click firing in the same tick cannot
   *  both start a request.
   *
   *  These pages are NOT written to the IndexedDB cache. The cache exists for the cold
   *  first paint, which is bounded to one page; persisting every page the user scrolled
   *  through would grow the cached list without bound and slow every subsequent boot,
   *  for a window that a reload resets anyway. Re-fetching a page is one cheap
   *  projected request.
   *
   *  Resolves when the page has landed or failed. A failure leaves the cursor in place
   *  so the affordance stays and the user can retry, and is logged rather than
   *  swallowed — an older page that silently never arrives reads as "that is all the
   *  sessions there are", which is the exact lie this method exists to fix. */
  async loadOlderSessions(): Promise<void> {
    const state = this.store.getState();
    const cursor = state.olderSessionsCursor;
    if (!cursor || state.olderSessionsLoading) return;
    const actions = state.actions;
    actions.setOlderSessionsLoading(true);
    try {
      const resp = await this.api.getSummary({ limit: this.sessionsPerPage, before: cursor });
      actions.appendOlderSessions(resp.sessions, resp.next ?? null);
    } catch (err) {
      actions.setOlderSessionsLoading(false);
      console.error('chat-core: older sessions page failed', err);
    }
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
