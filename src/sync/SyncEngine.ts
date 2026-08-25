import type { ApiClient } from '../net/ApiClient.js';
import type { SessionCache } from '../cache/SessionCache.js';
import { DEFAULT_LIST_CACHE_LIMIT, enforceCacheBound } from '../cache/evict.js';
import type { ChatStoreApi } from '../store/ChatStore.js';
import type { Validator } from '../net/types.js';
import { connectListSSE, connectSessionSSE } from './sse.js';
import { clearOpenSignalsCache } from '../react/signals.js';
import { announceSignalsChanged } from '../store/signalResolve.js';

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
  /** Sidebar sessions per page. Bounds the cache's list store, whose only reader
   *  is the cold-boot paint — one page wide. Must match the Prefetcher's, or the
   *  sweep trims rows the next boot wanted to paint. */
  sessionsPerPage?: number;
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
  private readonly sessionsPerPage: number;

  private listAbort: AbortController | null = null;
  private activeAbort: AbortController | null = null;
  private activeStreamId: string | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether the list stream has ever said hello. Distinguishes the first connect
   *  (boot already read the folders) from a reconnect (they may have changed under
   *  us while the stream was down). */
  private listHelloSeen = false;
  private unsubStore: (() => void) | null = null;
  private onVisible: (() => void) | null = null;
  private running = false;

  constructor(config: SyncEngineConfig) {
    this.store = config.store;
    this.api = config.api;
    this.cache = config.cache;
    this.sweepIntervalMs = config.sweepIntervalMs ?? 15000;
    this.sweepLimit = config.sweepLimit ?? 50;
    this.sessionsPerPage = config.sessionsPerPage ?? DEFAULT_LIST_CACHE_LIMIT;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.store.getState().actions.setConn('connecting');

    void this.runListStream();

    // React to activeId changes: attach/detach the single active-session SSE,
    // and re-check that what we are about to render is still current.
    let lastActive = this.store.getState().activeId;
    this.attachActive(lastActive);
    void this.revalidateActive(lastActive);
    this.unsubStore = this.store.subscribe((state) => {
      if (state.activeId !== lastActive) {
        lastActive = state.activeId;
        this.attachActive(lastActive);
        void this.revalidateActive(lastActive);
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
            // Folders are not on this stream — it carries session upserts and deletes
            // only — so a folder created, renamed or deleted while the client was
            // disconnected is invisible until something re-reads the list. A
            // reconnect is exactly the moment the sidebar's picture of the server is
            // in doubt, so it is re-read here. NOT on the first hello: `boot()` has
            // just fetched it, and sync starts after boot resolves.
            if (this.listHelloSeen) void this.refreshFolders();
            this.listHelloSeen = true;
          } else if (frame.type === 'upsert' && frame.summary) {
            actions.upsertSession(frame.summary);
            void this.cache.putSummary(frame.summary);
          } else if (frame.type === 'delete') {
            actions.removeSession(frame.sessionId);
            void this.cache.deleteSession(frame.sessionId);
          } else if (frame.type === 'signal') {
            // The server says this session's open questions moved. Drop the
            // cached open set and let the surfaces showing it re-read.
            //
            // This is what the 30-second TTL was standing in for. A question
            // answered anywhere else — another tab, the CLI, an orchestrator —
            // used to sit on screen until that lapsed, and now that answering
            // is a real round trip through the server, someone would watch it
            // happen.
            clearOpenSignalsCache();
            announceSignalsChanged();
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

  /** Re-read `GET /folders` after a reconnect. A failure keeps the folder list the
   *  client already has rather than clearing it — a stale order is closer to the
   *  truth than no order, and the next reconnect tries again. */
  private async refreshFolders(): Promise<void> {
    try {
      const folders = await this.api.listFolders();
      if (this.running) this.store.getState().actions.setFolders(folders);
    } catch {
      // Non-fatal: the sidebar keeps grouping with the list it has.
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
          // The resume cursor is the STREAM's own id line (llm-bridge-server's
          // row ids) — the only space the server's Last-Event-ID understands.
          if (ev.id) this.streamCursors.set(sessionId, ev.id);
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

  /** Per-session SSE resume cursor: the last frame id RECEIVED on the stream. */
  private streamCursors = new Map<string, string>();

  private lastEventIdFor(sessionId: string): string | undefined {
    // ⚠️ Never derived from the model's validator: that maxEventId is a
    // LOG-STORE row id, and the server parses Last-Event-ID in its OWN row-id
    // space. Sending the log-store number (numerically ahead) made the server
    // replay nothing, so every reconnect and every session open silently missed
    // the events between the page fetch and the stream connect — "nothing
    // streams until the final message is done". With no cursor the server
    // replays the current turn, which is exactly the wanted cold behaviour.
    return this.streamCursors.get(sessionId);
  }

  // --- validator sweep + silent repair ---

  async sweepValidators(): Promise<void> {
    try {
      await this.repairChangedValidators();
    } finally {
      // The bound is local housekeeping, not part of the validator work, so it
      // runs on a tick that found nothing cached and on a tick whose network read
      // failed. It used to sit at the tail of the method below, past two early
      // returns — and the list store grows from the live stream's upserts, which
      // do not stop when the sweep has nothing to check. A tab left open with no
      // session ever selected took neither branch and trimmed nothing.
      if (this.cache.isEnabled) {
        void enforceCacheBound(this.cache, this.sweepLimit, this.sessionsPerPage);
      }
    }
  }

  /** Compare each cached session's validator against the server's and repair the
   *  ones that both changed and are on screen. */
  private async repairChangedValidators(): Promise<void> {
    const state = this.store.getState();
    // ⚠️ The ACTIVE session is always checked, whatever its position in the map.
    //
    // `turnsBySession` is a Map, so `keys()` is INSERTION order — the sessions
    // opened longest ago. Slicing it alone meant the sweep fetched validators for
    // the 50 oldest-opened sessions and then repaired only the active one
    // (`isDisplayed` below), so once a window had opened more than `sweepLimit`
    // sessions the one actually on screen fell outside the slice and was never
    // checked at all. Exactly backwards: it polled 50 tails nobody was looking at
    // and skipped the only one that renders.
    //
    // That is the "leave a tab open for a while and it goes stale until you
    // refresh" report, and its severity grows with how much you use the page.
    const active = state.activeId;
    const swept = [...state.turnsBySession.keys()].slice(0, this.sweepLimit);
    const cachedIds =
      active && state.turnsBySession.has(active) && !swept.includes(active)
        ? [active, ...swept]
        : swept;
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
  }

  /** True iff this session's tail is currently being displayed. In this client the
   *  only displayed tail is the active (open) session; a warm-but-inactive session
   *  is never on screen, so its tail must not be refetched by the sweep. */
  private isDisplayed(sessionId: string): boolean {
    return this.store.getState().activeId === sessionId;
  }

  /**
   * Re-check the session that just became active, without waiting for the sweep.
   *
   * ⚠️ A CACHED session was previously not re-read at all on open. `select()`
   * fetches the tail only when the store has none (`hooks.ts`), which is what
   * makes a warm switch land in single-digit milliseconds — and it means a
   * session whose cached tail has since moved on renders stale and stays stale
   * until the 15s sweep happens to cover it. The original chat has no such gap:
   * `useBridgeSession` calls `loadHistory(id)` on EVERY open, cached or not.
   *
   * This keeps the fast paint and closes the gap behind it: the cache is drawn
   * immediately, one cheap validator read follows, and the tail is refetched only
   * if the server's validator disagrees. A session the store has never seen is
   * skipped — `select()` is already fetching it, and asking twice would race.
   *
   * Placed on the activeId SUBSCRIPTION rather than inside `select()` so it holds
   * for every way a session becomes active: a sidebar row, a `?session=`
   * deeplink, a `[session:…]` ref chip, the signals inbox, and the subagent tree.
   */
  private async revalidateActive(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    const local = this.store.getState().turnsBySession.get(sessionId)?.validator;
    if (!local) return;
    let serverValidators;
    try {
      serverValidators = await this.api.getValidators([sessionId]);
    } catch {
      return; // The sweep will try again; a stale tail is not worth a thrown error.
    }
    if (validatorsEqual(local, serverValidators[sessionId])) return;
    // Still the active one? The user may have moved on during the round trip, and
    // repairing a session nobody is looking at is the over-poll this file already
    // guards against everywhere else.
    if (this.store.getState().activeId !== sessionId) return;
    await this.repairSession(sessionId);
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
