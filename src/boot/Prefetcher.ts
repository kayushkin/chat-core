import type { ApiClient } from '../net/ApiClient.js';
import type { SessionCache } from '../cache/SessionCache.js';
import { enforceCacheBound } from '../cache/evict.js';
import type { ChatStoreApi, FilterState } from '../store/ChatStore.js';
import type { SessionSummaryFilterAxes } from '../net/types.js';
import { isEmptySummaryFilter } from '../net/types.js';

/** Narrow a `FilterState` to the six axes the summary endpoint understands.
 *
 *  Explicit rather than handing the whole `FilterState` over: `folder` and `search`
 *  are not server-side filters, and picking the six states that at the boundary
 *  instead of relying on the request builder to quietly ignore the other two. */
function summaryFilterAxesOf(filter: FilterState): SessionSummaryFilterAxes {
  return {
    harness: filter.harness,
    status: filter.status,
    type: filter.type,
    purpose: filter.purpose,
    mode: filter.mode,
    machine: filter.machine,
  };
}

// Boot sequence (§6) + hover/idle prefetch. The boot order is the whole latency
// story: hydrate from cache and PAINT first (0 network), THEN fan out the three
// parallel reads. Hover/idle prefetch warms a cold session before the click so a
// select() is a Map read.
//
// HOW THE SIDEBAR'S WINDOW FILLS, IN THREE STAGES.
//
// 1. The boot page is FILTERED by whatever the sidebar's chips are set to, which
//    `createChatStore()` has already restored from localStorage before the first
//    paint. The page is a strict newest-first prefix, so on this box an unfiltered
//    one is spent on machine traffic: measured over the live table, interactive
//    sessions are ~8% of any recent window, and reaching 50 of them means paging
//    677 rows deep. Filtering server-side is what makes the first page relevant
//    rather than merely recent.
//
// 2. `deepenInBackground()` then keeps paging, yielding between pages, until the
//    window holds `backgroundSessionBudget` sessions. It walks the FILTERED stream
//    first — the sessions the user asked for — and only then the unfiltered one,
//    so the facet chips end up describing more than the filtered slice they would
//    otherwise be counting.
//
// 3. Past that budget the "Load older sessions" button takes over, as before.
//
// The budget is the point: this box has ~8,845 sessions and holding all of them is
// the unbounded list load the rewrite exists to kill. Holding a bounded prefix is
// not — measured, a full filter/group/sort/facet recompute over 2,500 loaded rows
// costs 1.3ms, well inside a frame, against 0.1ms at 100.

export interface PrefetcherConfig {
  store: ChatStoreApi;
  api: ApiClient;
  cache: SessionCache;
  recentN?: number;
  turnsPerBundle?: number;
  cacheLimit?: number;
  /** Sessions per sidebar page, for the boot page and every older page after it. */
  sessionsPerPage?: number;
  /** Stop background deepening once the window holds this many sessions; 0 disables
   *  background deepening entirely and restores the pre-deepening behaviour. */
  backgroundSessionBudget?: number;
}

/** Which stream `loadOlderSessions` is currently walking.
 *
 *  Two streams exist because they answer two different questions. The FILTERED one
 *  is "more of what the user asked for"; the UNFILTERED one is "everything", which
 *  is what keeps the facet chips honest — they tally the loaded window, so a window
 *  holding only interactive sessions can no longer report that autoworkers exist.
 *
 *  With no filter set the two streams are the same query, so paging starts directly
 *  on 'unfiltered' and the handover never happens. */
type SessionPagingStream = 'filtered' | 'unfiltered';

export class Prefetcher {
  /** Default sessions per sidebar page. Mirrors the summary endpoint's own default
   *  so a boot that names no page size asks for exactly what the server would give. */
  static readonly DEFAULT_SESSIONS_PER_PAGE = 100;

  /** Default ceiling on the background-loaded window.
   *
   *  Not a performance limit — the measured recompute cost is ~1.3ms at 2,500 rows
   *  and ~5.8ms at the full 8,845, both inside a frame. It is a restraint: past a
   *  couple of thousand rows the marginal session is one nobody is going to scroll
   *  to, and the button is right there for the rest. */
  static readonly DEFAULT_BACKGROUND_SESSION_BUDGET = 2000;

  /** Longest a background page will wait for an idle moment before going anyway.
   *  Without a deadline a busy tab never deepens at all; with one the loop makes
   *  progress and still yields first whenever the page is quiet. */
  private static readonly BACKGROUND_PAGE_IDLE_TIMEOUT_MS = 500;

  private readonly store: ChatStoreApi;
  private readonly api: ApiClient;
  private readonly cache: SessionCache;
  private readonly recentN: number;
  private readonly turnsPerBundle: number;
  private readonly cacheLimit: number;
  private readonly sessionsPerPage: number;
  private readonly backgroundSessionBudget: number;
  /** Hover prefetches in flight, by session id — the PROMISE, not just the id.
   *
   *  A bare Set could say "someone is fetching this" but not "join that fetch", and
   *  the click path needs the second: hovering a sidebar row and then clicking it is
   *  how every session is opened, and the two used to fetch the same page twice,
   *  concurrently, because each guarded on a register the other could not see.
   *  Measured on the live dashboard — two `GET /messages` for one open, 2-19ms
   *  apart, each parsing a page up to a megabyte. */
  private readonly inFlight = new Map<string, Promise<void>>();

  /** The filter the boot page was fetched with, and the one the filtered stream
   *  keeps paging.
   *
   *  Captured ONCE at boot and deliberately not re-read when the user clicks a
   *  chip. Chip clicks stay instant and local — they re-sieve the loaded window
   *  with no round trip — and re-aiming the background loader mid-flight would
   *  abandon a half-walked stream for one whose rows are already arriving anyway
   *  as the unfiltered stage runs. */
  private bootFilter: SessionSummaryFilterAxes = {};
  private pagingStream: SessionPagingStream = 'unfiltered';
  /** Whether the unfiltered stream has fetched anything yet.
   *
   *  This is what tells the two meanings of a null cursor apart. On the unfiltered
   *  stream a null cursor means "exhausted, stop" once it has started, and "not
   *  opened yet, start from the newest" before that. Without the flag the loop
   *  either stops before the unfiltered stage or re-fetches page one forever. */
  private unfilteredStreamStarted = false;
  private backgroundDeepenRunning = false;
  private backgroundDeepenStopped = false;

  constructor(config: PrefetcherConfig) {
    this.store = config.store;
    this.api = config.api;
    this.cache = config.cache;
    this.recentN = config.recentN ?? 20;
    this.turnsPerBundle = config.turnsPerBundle ?? 30;
    this.cacheLimit = config.cacheLimit ?? 50;
    this.sessionsPerPage = config.sessionsPerPage ?? Prefetcher.DEFAULT_SESSIONS_PER_PAGE;
    this.backgroundSessionBudget =
      config.backgroundSessionBudget ?? Prefetcher.DEFAULT_BACKGROUND_SESSION_BUDGET;
  }

  /** Step 1: hydrate the store from IndexedDB and paint. 0 network. Resolves
   *  once the cached list + turns are in the store (or immediately if disabled). */
  async hydrateFromCache(): Promise<void> {
    if (!this.cache.isEnabled) return;
    const actions = this.store.getState().actions;
    try {
      const hydrated = await this.cache.hydrate();
      // Bounded to one page, so the paint cannot show hundreds of rows and then
      // SHRINK back the moment the network's first page replaces them. The cached
      // list is sorted newest-first, so the head of it is the same window page one
      // is about to confirm.
      //
      // The slice is the ONLY thing bounding this paint. `enforceListBound` bounds
      // the IndexedDB list store and nothing else — an earlier version of this
      // comment claimed it "keeps the store itself this wide", which was never true
      // of `state.sessions`: no cap on the in-memory window exists anywhere, which
      // is exactly why background deepening can grow it and why that growth needs a
      // budget of its own rather than an evictor to catch it.
      const painted = hydrated.list.slice(0, this.sessionsPerPage);
      if (painted.length > 0) actions.setSessions(painted);
      for (const [id, model] of hydrated.turns) {
        // The cached resume point rides with the cached model, so a session painted from
        // disk still opens its stream with one. Without it the server replays that
        // session's whole current turn — which on a cold boot is most of the sidebar.
        actions.setTurns(id, model, { streamHead: hydrated.streamResume.get(id) });
      }
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

    // The restored chip selection, read straight off the store rather than passed
    // in: `createChatStore()` rehydrates it synchronously, so it is already correct
    // here and a second copy threaded through config would be a second source of
    // truth for the same six arrays.
    this.bootFilter = summaryFilterAxesOf(this.store.getState().filter);
    // With nothing selected the filtered and unfiltered streams are the same query,
    // so start on 'unfiltered' and skip a handover that would re-fetch page one.
    this.pagingStream = isEmptySummaryFilter(this.bootFilter) ? 'unfiltered' : 'filtered';
    // With no filter the boot page IS the unfiltered stream's first page, so the
    // stream is already open. With one, the boot page belongs to the filtered
    // stream and the unfiltered stage has not begun.
    this.unfilteredStreamStarted = this.pagingStream === 'unfiltered';

    const summaryP = this.api
      .getSummary({ limit: this.sessionsPerPage, filter: this.bootFilter })
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
          actions.setTurns(id, entry.model, { streamHead: entry.stream?.head });
          void this.cache.putSummary(entry.summary);
          void this.cache.putTurns(entry.model, entry.stream?.head);
        }
        return bundle;
      })
      .catch(() => null);

    const validatorsP =
      cachedIds.length > 0
        ? this.api.getValidators(cachedIds).catch(() => null)
        : Promise.resolve(null);

    // The folder list is boot data: it decides the order the sidebar's groups paint
    // in and which folders exist at all, so it belongs in the parallel fan-out
    // rather than behind the SSE handshake (which only starts once boot resolves).
    // A failure leaves `folders` empty, which grouping already treats as "not loaded"
    // and degrades to the loaded sessions' own folder names — the sidebar never goes
    // blank over it. The SyncEngine re-reads it on every RECONNECT, so a folder
    // created elsewhere while the stream was down still arrives.
    const foldersP = this.api
      .listFolders()
      .then((folders) => {
        actions.setFolders(folders);
        return folders;
      })
      .catch(() => null);

    await Promise.all([summaryP, bundleP, validatorsP, foldersP]);

    // The list bound is the page size, not a constant: the cold paint reads one
    // page, so one page is exactly what is worth keeping.
    if (this.cache.isEnabled) {
      void enforceCacheBound(this.cache, this.cacheLimit, this.sessionsPerPage);
    }
  }

  /** Full boot: cache paint → parallel prime → background deepening.
   *
   *  The deepening is deliberately NOT awaited. `boot()` resolving is what starts
   *  the SSE handshake, and holding that open for twenty background pages would
   *  make the sidebar live only once it had finished filling — the opposite of the
   *  point. It runs behind the painted list and stops on its own. */
  async boot(): Promise<void> {
    await this.hydrateFromCache();
    await this.prime();
    void this.deepenInBackground();
  }

  /** Keep pulling pages behind the painted sidebar until the window holds
   *  `backgroundSessionBudget` sessions, then stop and leave the rest to the
   *  "Load older sessions" button.
   *
   *  Yields between pages, so a page lands, the list repaints, and only then does
   *  the next request go out. One page at a time, never a fan-out: the pages are
   *  cursor-chained and page N+1's cursor is not known until page N lands.
   *
   *  Re-entrant calls are refused rather than queued — two loops sharing one cursor
   *  would each fetch the page the other just did. */
  async deepenInBackground(): Promise<void> {
    if (this.backgroundSessionBudget <= 0) return;
    // A fresh call is a fresh intent to deepen, so it clears any previous stop.
    // React StrictMode mounts, unmounts and remounts in development: without this,
    // the first unmount's stop would disable deepening for the remount that follows
    // it, and the sidebar would sit at one page with nothing saying why.
    this.backgroundDeepenStopped = false;
    if (this.backgroundDeepenRunning) return;
    this.backgroundDeepenRunning = true;
    try {
      while (!this.backgroundDeepenStopped) {
        const state = this.store.getState();
        if (state.sessions.size >= this.backgroundSessionBudget) return;
        // Both streams walked out. The cursor is the only "is there more" signal
        // the endpoint offers, so a null one here means there is genuinely nothing
        // left to pull.
        if (!state.olderSessionsCursor && this.pagingStream === 'unfiltered') return;
        const before = state.sessions.size;
        await this.loadOlderSessions();
        // A page that added nothing means the stream is spent or the request
        // failed; either way, looping again would spin on the same cursor.
        if (this.store.getState().sessions.size <= before) return;
        await this.waitForIdle();
      }
    } finally {
      this.backgroundDeepenRunning = false;
    }
  }

  /** Stop background deepening. Idempotent, and safe to call mid-page — the page in
   *  flight still lands, the loop just does not start another. */
  stopBackgroundDeepening(): void {
    this.backgroundDeepenStopped = true;
  }

  /** Resolve on the next idle moment, or after a deadline on a page that never goes
   *  idle. `requestIdleCallback` is absent in Safari and in jsdom, so the timeout is
   *  the path taken there rather than a fallback nicety. */
  private waitForIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      const idle = (
        globalThis as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        }
      ).requestIdleCallback;
      if (typeof idle === 'function') {
        idle(() => resolve(), { timeout: Prefetcher.BACKGROUND_PAGE_IDLE_TIMEOUT_MS });
      } else {
        setTimeout(resolve, Prefetcher.BACKGROUND_PAGE_IDLE_TIMEOUT_MS);
      }
    });
  }

  /** Pull the next page of OLDER sessions and merge it into the sidebar's window.
   *
   *  Walks the filtered stream first and the unfiltered one after it (see
   *  `SessionPagingStream`), handing over transparently — the caller neither knows
   *  nor needs to know which stream a page came from. Both the background loop and
   *  the "Load older sessions" button go through here, so the button simply resumes
   *  wherever the background loader stopped.
   *
   *  No-op when a page is already in flight — the in-flight flag is set synchronously
   *  before the fetch, so a scroll event and a button click firing in the same tick
   *  cannot both start a request — or when the unfiltered stream has run out, which
   *  is the only state that means there is genuinely nothing older.
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
    if (state.olderSessionsLoading) return;
    const cursor = state.olderSessionsCursor;
    if (!cursor) {
      // A null cursor on the FILTERED stream is not the end of the list, only the
      // end of that stream: the boot page reported no second filtered page. Switch
      // BEFORE fetching, so the unfiltered stream opens directly rather than
      // spending a request rediscovering that the filtered one is spent.
      if (this.pagingStream === 'filtered') this.pagingStream = 'unfiltered';
      // On the unfiltered stream a null cursor means the end — but only once that
      // stream has actually run. Before it has, it means "start from the newest".
      else if (this.unfilteredStreamStarted) return;
    }
    const actions = state.actions;
    actions.setOlderSessionsLoading(true);
    try {
      const filtered = this.pagingStream === 'filtered';
      if (!filtered) this.unfilteredStreamStarted = true;
      const resp = await this.api.getSummary({
        limit: this.sessionsPerPage,
        before: cursor ?? undefined,
        filter: filtered ? this.bootFilter : undefined,
      });
      if (resp.next == null && filtered) {
        // Hand over within the SAME call. Writing null and switching on the next
        // one would park the store on "there is nothing older" in between, and that
        // is exactly what the sidebar reads to decide whether to draw the "Load
        // older sessions" button — it would blink out and back for a round trip.
        this.pagingStream = 'unfiltered';
        this.unfilteredStreamStarted = true;
        const unfilteredFirst = await this.api.getSummary({ limit: this.sessionsPerPage });
        actions.appendOlderSessions(
          [...resp.sessions, ...unfilteredFirst.sessions],
          unfilteredFirst.next ?? null,
        );
        return;
      }
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
    const state = this.store.getState();
    if (state.turnsBySession.has(sessionId)) return;
    if (state.turnsLoading.has(sessionId)) return;
    if (this.inFlight.has(sessionId)) return;
    // Announce the fetch in the SHARED store, not just in `inFlight`. Two other parts of
    // the system need to know a page is coming and neither can see a private field:
    // `select()` joins this fetch instead of starting a second one, and the SyncEngine
    // waits for the resume point it will carry instead of connecting the stream cold and
    // having the whole current turn replayed at it. Reading `turnsLoading` without ever
    // setting it — which is what this did — left both of them blind on exactly the path
    // a session is normally opened by: hover, then click.
    state.actions.setTurnsLoading(sessionId, true);
    const warming = this.warm(sessionId);
    this.inFlight.set(sessionId, warming);
    // A hover that fails is not an error: nothing is on screen waiting for it and the
    // click path fetches on demand. The handler is attached HERE, on the hover's own
    // reference, because `warming()` hands the same promise to `select()` and a
    // rejection nobody ever claimed — the user hovered and moved on — would otherwise
    // surface as an unhandled rejection in the console.
    void warming.catch(() => {});
  }

  /**
   * The hover prefetch in flight for this session, or undefined.
   *
   * `select()` joins it instead of starting its own fetch — see `inFlight`. It is
   * exposed as the PROMISE so the caller can also handle the prefetch FAILING: a
   * click that merely skipped its own fetch on the strength of a prefetch that then
   * errored would leave the pane empty with nothing left to retry it.
   */
  warming(sessionId: string): Promise<void> | undefined {
    return this.inFlight.get(sessionId);
  }

  private async warm(sessionId: string): Promise<void> {
    try {
      const resp = await this.api.getMessages(sessionId, { limit: this.turnsPerBundle });
      // Re-check: a live select() may have already warmed it.
      if (!this.store.getState().turnsBySession.has(sessionId)) {
        this.store
          .getState()
          .actions.setTurns(sessionId, resp.model, { streamHead: resp.stream?.head });
      }
      // Coalesced: this is a cache fill, and nothing is waiting on it reaching disk.
      this.cache.scheduleTurnsWrite(resp.model, resp.stream?.head);
    } finally {
      this.inFlight.delete(sessionId);
      // `setTurns` already cleared this on the success path; clearing it again is a
      // no-op. On the failure path it is the only thing that does, and leaving it set
      // would tell `select()` a page is still coming when nothing is fetching.
      this.store.getState().actions.setTurnsLoading(sessionId, false);
    }
  }
}
