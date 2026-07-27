import type { ApiClient } from '../net/ApiClient.js';
import type { SessionCache } from '../cache/SessionCache.js';
import { enforceCacheBound } from '../cache/evict.js';
import type { ChatStoreApi } from '../store/ChatStore.js';
import type { Validator } from '../net/types.js';
import { connectListSSE, connectSessionSSE } from './sse.js';

// L2 sync (decision D6). Owns exactly:
//   - ONE global list SSE (list deltas → session upsert/delete)
//   - ONE active-session SSE (only for the current activeId), with Last-Event-ID
//     resume + per-eventId dedup (the reducer handles the latter, idempotently)
//   - a validator sweep on an interval + on visibilitychange
// Reconcile is a SILENT repair: a mismatch refetches the tail and repairs the
// cache; it changes VISIBLE store state only when the moved session is the open
// one. Warm-but-inactive sessions never get a live stream — they are refreshed
// by the sweep, never by 20 open sockets.

export interface SyncEngineConfig {
  store: ChatStoreApi;
  api: ApiClient;
  cache: SessionCache;
  sweepIntervalMs?: number;
  sweepLimit?: number;
}

function validatorsEqual(a: Validator | undefined, b: Validator | undefined): boolean {
  if (!a || !b) return false;
  return a.maxEventId === b.maxEventId && a.eventCount === b.eventCount;
}

export class SyncEngine {
  private readonly store: ChatStoreApi;
  private readonly api: ApiClient;
  private readonly cache: SessionCache;
  private readonly sweepIntervalMs: number;
  private readonly sweepLimit: number;

  private listAbort: AbortController | null = null;
  private activeAbort: AbortController | null = null;
  private activeStreamId: string | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private unsubStore: (() => void) | null = null;
  private onVisible: (() => void) | null = null;
  private running = false;

  constructor(config: SyncEngineConfig) {
    this.store = config.store;
    this.api = config.api;
    this.cache = config.cache;
    this.sweepIntervalMs = config.sweepIntervalMs ?? 15000;
    this.sweepLimit = config.sweepLimit ?? 50;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.store.getState().actions.setConn('connecting');

    void this.runListStream();

    // React to activeId changes: attach/detach the single active-session SSE.
    let lastActive = this.store.getState().activeId;
    this.attachActive(lastActive);
    this.unsubStore = this.store.subscribe((state) => {
      if (state.activeId !== lastActive) {
        lastActive = state.activeId;
        this.attachActive(lastActive);
      }
    });

    this.sweepTimer = setInterval(() => void this.sweepValidators(), this.sweepIntervalMs);

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.onVisible = () => {
        if (document.visibilityState === 'visible') void this.sweepValidators();
      };
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  stop(): void {
    this.running = false;
    this.listAbort?.abort();
    this.activeAbort?.abort();
    this.listAbort = null;
    this.activeAbort = null;
    this.activeStreamId = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.unsubStore?.();
    this.unsubStore = null;
    if (this.onVisible && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    this.onVisible = null;
    this.store.getState().actions.setConn('closed');
  }

  // --- global list stream, with backoff reconnect ---

  private async runListStream(): Promise<void> {
    let delay = 1000;
    while (this.running) {
      const abort = new AbortController();
      this.listAbort = abort;
      try {
        for await (const frame of connectListSSE(this.api.fetchFor(), this.api.basePath, abort.signal)) {
          if (!this.running) return;
          const actions = this.store.getState().actions;
          if (frame.type === 'hello') {
            delay = 1000;
            actions.setConn('open');
          } else if (frame.type === 'upsert' && frame.summary) {
            actions.upsertSession(frame.summary);
            void this.cache.putSummary(frame.summary);
          } else if (frame.type === 'delete') {
            actions.removeSession(frame.sessionId);
            void this.cache.deleteSession(frame.sessionId);
          }
        }
      } catch {
        if (abort.signal.aborted || !this.running) return;
      }
      if (!this.running) return;
      this.store.getState().actions.setConn('connecting');
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }

  // --- active session stream ---

  private attachActive(sessionId: string | null): void {
    if (this.activeStreamId === sessionId) return;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.activeStreamId = sessionId;
    if (!sessionId) return;
    void this.runActiveStream(sessionId);
  }

  private async runActiveStream(sessionId: string): Promise<void> {
    let delay = 1000;
    const abort = new AbortController();
    this.activeAbort = abort;
    while (this.running && this.activeStreamId === sessionId && !abort.signal.aborted) {
      try {
        const lastEventId = this.lastEventIdFor(sessionId);
        const stream = connectSessionSSE(
          this.api.fetchFor(),
          this.api.basePath,
          sessionId,
          lastEventId,
          abort.signal,
        );
        for await (const ev of stream) {
          if (!this.running || this.activeStreamId !== sessionId) return;
          delay = 1000;
          this.store.getState().actions.applyTailEvent(sessionId, ev);
          const model = this.store.getState().turnsBySession.get(sessionId);
          if (model) void this.cache.putTurns(model);
        }
      } catch {
        if (abort.signal.aborted || this.activeStreamId !== sessionId) return;
      }
      if (!this.running || this.activeStreamId !== sessionId) return;
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }

  private lastEventIdFor(sessionId: string): string | undefined {
    const model = this.store.getState().turnsBySession.get(sessionId);
    const max = model?.validator.maxEventId ?? 0;
    return max > 0 ? String(Math.floor(max)) : undefined;
  }

  // --- validator sweep + silent repair ---

  async sweepValidators(): Promise<void> {
    const state = this.store.getState();
    const cachedIds = [...state.turnsBySession.keys()].slice(0, this.sweepLimit);
    if (cachedIds.length === 0) return;

    let serverValidators;
    try {
      serverValidators = await this.api.getValidators(cachedIds);
    } catch {
      return; // network hiccup — try again next tick.
    }

    for (const id of cachedIds) {
      const server = serverValidators[id];
      const local = this.store.getState().turnsBySession.get(id)?.validator;
      if (validatorsEqual(local, server)) continue;
      // Idle over-poll fix: a changed validator only justifies pulling the heavy
      // message tail when this session's tail is actually on screen — i.e. it is
      // the active/open one. For an UNSELECTED cached session (even a running one)
      // we stop here: the cheap validator check has already run, and the full
      // ~500 KB tail is NOT fetched. It self-heals when the session next becomes
      // active — the active-session SSE resumes from Last-Event-ID and replays the
      // missed events, and this sweep repairs it once activeId points at it.
      if (this.isDisplayed(id)) {
        await this.repairSession(id);
      }
    }

    if (this.cache.isEnabled) {
      void enforceCacheBound(this.cache, this.sweepLimit);
    }
  }

  /** True iff this session's tail is currently being displayed. In this client the
   *  only displayed tail is the active (open) session; a warm-but-inactive session
   *  is never on screen, so its tail must not be refetched by the sweep. */
  private isDisplayed(sessionId: string): boolean {
    return this.store.getState().activeId === sessionId;
  }

  /** Silent repair: refetch the tail, repair the cache, and update VISIBLE store
   *  state only when this session is the active (open) one. */
  private async repairSession(sessionId: string): Promise<void> {
    let resp;
    try {
      resp = await this.api.getMessages(sessionId, { limit: 30 });
    } catch {
      return;
    }
    const model = resp.model;
    void this.cache.putTurns(model);
    if (this.store.getState().activeId === sessionId) {
      this.store.getState().actions.setTurns(sessionId, model);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
