import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  Entry,
  HarnessConfig,
  HarnessMeta,
  ManagedSessionDetail,
  ModelOption,
  PendingHook,
  SearchHit,
  SessionInfo,
  SessionSummary,
  Turn,
  TurnModel,
} from '../net/types.js';
import type { WireEvent } from '../net/wireEvents.js';
import { applyEvent, initTailState, type TailState } from '../reduce/TurnReducer.js';
import { foldHookEvent } from './pendingHooks.js';
import { budgetHaltFromEvent, type BudgetHalt } from './budgetHalt.js';
import { DraftStore, defaultDraftStorage, type DraftStorageLike } from './draftStorage.js';
import { FilterStore, PERSISTED_FILTER_AXES } from './filterStorage.js';
import { defaultWebStorage, type WebStorageLike } from './webStorage.js';

// L1 hot store (decision D2). Zustand vanilla store held in `Map`s for the
// working set. ACTIONS ARE THE ONLY MUTATION PATH — both the SyncEngine and the
// UI go through them, so the optimistic and reconciled paths converge on one
// model. Selector subscriptions (see react/hooks.ts) mean only components whose
// slice changed re-render.

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed';

/**
 * Sidebar filter state. Each faceted axis (`harness`, `status`, `type`, `purpose`,
 * `mode`, `machine`) is now MULTI-SELECT: a `string[]` where an empty array means
 * "no filter on this axis". Matching is OR **within** an axis (any selected value
 * matches) and AND **across** axes (every non-empty axis must match) — see
 * `matchesFilter`. `folder` and `search` keep their scalar semantics.
 *
 * The `machine` axis matches `SessionSummary.instanceId`: the summary carries no
 * machine field, and instanceId is the value the dash resolves to a machine display
 * name (via bridge-ui `useBridgeMachines`). So the dash passes instanceId values here
 * (grouped by machine on its side) — `selectFacets().machine` is likewise keyed by
 * instanceId.
 */
export interface FilterState {
  harness: string[];
  status: string[];
  type: string[];
  purpose: string[];
  mode: string[];
  machine: string[];
  folder: string | null;
  search: string;
}

export const EMPTY_FILTER: FilterState = {
  harness: [],
  status: [],
  type: [],
  purpose: [],
  mode: [],
  machine: [],
  folder: null,
  search: '',
};

/** Where a new chat is aimed and what it starts configured with.
 *
 *  `instanceId` / `harness` say WHERE the session is created; the other four are
 *  runtime settings the create call deliberately does not take (bridge-ui parity —
 *  `POST /sessions` carries the target only). They ride on the pending pane and are
 *  applied by a single `POST /sessions/{id}/config` right after the real session is
 *  lazily created on first send.
 *
 *  Two sources feed the settings and they are the same shape on purpose: the
 *  controls bar's pre-start picks, and the caller's saved per-harness defaults
 *  (dash resolves those from `bridge-prefs`). A pre-start pick beats a saved
 *  default; that precedence belongs to the caller, not here. */
export interface NewSessionOpts {
  instanceId?: string;
  harness?: string;
  model?: string;
  effort?: string;
  /** ⚠️ ZERO IS A REAL VALUE and means NO CEILING on the server — never fold it in
   *  with absent. Absent means "the server decides"; 0 means "do not stop me". */
  maxBudget?: number;
  /** An EMPTY ARRAY is also a real value: "disable nothing", which is not the same
   *  answer as absent ("inherit whatever the harness does by default"). */
  disabledTools?: string[];
}

/** A pending (not-yet-created) session pane — 0 network until first send. Carries the
 *  `NewSessionOpts` its lazy create and follow-up config call will use. */
export interface PendingSession extends NewSessionOpts {
  clientId: string;
}

/** Content-search augmentation (C6). The set of session ids whose materialized
 *  transcript text matched `query`, fetched async via `ApiClient.search`. `query`
 *  pins the hits to the filter they were fetched for, so a stale set is never
 *  folded into a newer search. The instant local name match never waits on this.
 *
 *  `query` is always the TRIMMED search string. `filter.search` keeps whatever the
 *  user typed, spaces and all; every comparison against it here and in
 *  `matchesFilter` trims first. They used to be compared raw against a trimmed
 *  `query`, so a query with a leading or trailing space failed the equality check
 *  and its hits were dropped on arrival with no error. */
export interface ContentHits {
  query: string;
  /** How many events of that session's transcript matched, by session id — the
   *  whole `SearchHit` list, keyed for lookup rather than reduced to membership.
   *
   *  This used to be a bare `Set<string>` of the ids, which threw away the only
   *  ranking signal the backend offers: `ApiClient.search` sorts the hits by
   *  descending `match_count` and the store dropped the counts one call later, so
   *  the sidebar ordered content hits by recency and a session with one incidental
   *  match outranked the session the query was actually about.
   *
   *  A `Map` answers membership with `.has` and size with `.size` exactly as the
   *  Set did, so nothing that only asked "did this session match?" had to change. */
  matchCountBySessionId: Map<string, number>;
  /** How many hits the backend returned for `query` — `matchCountBySessionId.size`,
   *  kept explicitly because it is a count of what the SERVER found, while the
   *  number of rows the list can actually paint is bounded by the loaded window and
   *  is always ≤ this. */
  hitCount: number;
  /** True when the backend filled a whole page, so there are more matches it never
   *  sent. See `SearchResponse.truncated` — this is "at least", not a total. */
  truncated: boolean;
}

export interface ChatState {
  sessions: Map<string, SessionSummary>;
  turnsBySession: Map<string, TurnModel>;
  /** Lazily-fetched per-session detail info (system prompt, tools, permission mode,
   *  …), keyed by session id. A present key — even mapping to `null` — means the
   *  detail was fetched (null = the harness reported no info yet), so `useSessionInfo`
   *  never re-fetches. Populated on first use, never on the hot path. */
  sessionInfo: Map<string, SessionInfo | null>;
  /** Session ids whose detail fetch is in flight (drives `useSessionInfo` loading). */
  sessionInfoLoading: Set<string>;
  /** Lazily-fetched FULL per-session detail (`ManagedSessionDetail`: summary + info +
   *  harnessConfig), keyed by session id — the source for `useManagedSession` and the
   *  interactive permission-mode selector. A present key mapping to a detail means it
   *  was fetched; distinct from `sessionInfo` (which caches only the `info` sub-blob).
   *  Populated on first use, never on the hot path. */
  sessionDetail: Map<string, ManagedSessionDetail>;
  /** Session ids whose full-detail fetch is in flight (drives `useManagedSession` loading). */
  sessionDetailLoading: Set<string>;
  /** Internal live-tail reducer state per session (not for direct UI reads). */
  tails: Map<string, TailState>;
  /** Hooks parked on a human decision, `sessionId -> requestId -> PendingHook`. A
   *  session with an entry here has a tool call frozen mid-turn; nothing else in the
   *  model shows it, so this map is the ONLY thing standing between a permission ask
   *  and a chat that hangs with no visible cause. Hydrated per session from
   *  `GET /sessions/{id}/hooks/pending` and kept live by the session SSE. */
  pendingHooks: Map<string, Map<string, PendingHook>>;
  /** Sessions stopped at their spend ceiling, `sessionId -> BudgetHalt`. A halted
   *  session refuses every send, resume and mode switch with a 402 until its ceiling
   *  moves, and nothing else in the model records that — the session just stops
   *  answering. Set from the 402 a refused request throws and from the mid-turn
   *  `budget_exceeded` error event; cleared when the ceiling is raised. */
  budgetHalts: Map<string, BudgetHalt>;
  activeId: string | null;
  filter: FilterState;
  /** Content-search hits for the current `filter.search`, or null when none have
   *  been fetched (or the query changed and the prior set was invalidated). */
  contentHits: ContentHits | null;
  /** The TRIMMED query a content search is currently running for — counting its
   *  debounce wait, because from the user's side the search has already been asked
   *  for — or null when none is running.
   *
   *  `contentHits === null` is NOT the same fact and cannot stand in for it: hits
   *  are also null before anyone has typed, and they stay null after a search that
   *  failed. Deriving "searching" from them would leave the sidebar saying
   *  "searching…" forever the first time the gateway refuses a query. */
  contentSearchInFlight: string | null;
  /** Why the last content search for the live query failed, or null. A failed
   *  transcript search is not zero matches — the list still shows every local name
   *  match — so it is reported rather than folded into an empty hit set. */
  contentSearchError: string | null;
  /** The folders the server holds, IN THE ORDER IT KEEPS THEM (`GET /folders`).
   *
   *  Not derived from the loaded sessions. A folder is a row of its own: it exists
   *  before anything is filed into it and it survives the last session leaving it,
   *  so a list scraped off the session window can neither order the folders the way
   *  the user arranged them nor represent an empty one at all. `visibleSessions`
   *  reads this to seed its groups.
   *
   *  Empty until the first `/folders` response lands (or if that read fails), which
   *  is a real state and not a bug: grouping falls back to the loaded sessions'
   *  own folder names in recency order rather than to an empty sidebar. */
  folders: string[];
  connState: ConnState;
  listLoading: boolean;
  /** The opaque cursor for the page of sessions OLDER than everything loaded, taken
   *  from the last summary response's `next`. `null` means there is no older page —
   *  either the server said so (a short page), or no page has landed yet. This is the
   *  only "is the sidebar truncated?" signal that exists: the summary endpoint reports
   *  no total, so a non-null cursor means "at least one more page", never "N more". */
  olderSessionsCursor: string | null;
  /** True while the older-sessions page fetch is in flight. Guards the fetch against a
   *  second scroll/click firing before the first lands. */
  olderSessionsLoading: boolean;
  turnsLoading: Set<string>;
  moreBySession: Map<string, boolean>;
  /** Unsent composer text, keyed by session id — plus one entry under the pending
   *  pane's key (`PENDING_DRAFT_KEY` in react/hooks.ts) for a chat that has no session
   *  yet. Persisted to localStorage by `draftStorage.ts` and read back synchronously
   *  at store construction, so a reload does not eat a half-typed message. */
  drafts: Map<string, string>;
  sending: Set<string>;
  pending: PendingSession | null;

  /** The harness registry from `GET /harnesses` — the canonical source the controls bar
   *  gates on (`capabilities`) and scopes the model picker with (`supportedProviders`).
   *  `null` means "not fetched yet"; `useHarnessCapabilities` / `useModels` fetch it once
   *  on first use, never on the hot path. */
  harnesses: HarnessMeta[] | null;
  /** True while the one-shot `GET /harnesses` fetch is in flight. */
  harnessesLoading: boolean;
  /** The model registry from `GET /models` (enabled rows only), projected to
   *  `ModelOption`s. `null` means "not fetched yet"; `useModels` fetches it once on first
   *  use. */
  models: ModelOption[] | null;
  /** True while the one-shot `GET /models` fetch is in flight. */
  modelsLoading: boolean;

  actions: ChatActions;
}

export interface ChatActions {
  setConn(state: ConnState): void;
  setListLoading(loading: boolean): void;

  /** Replace the loaded window with `list` and re-anchor the older-sessions cursor to
   *  `olderSessionsCursor`. Replace, not merge, is deliberate: the first page IS the
   *  window, so a session the server no longer returns must leave the sidebar. That
   *  also means any older page loaded earlier is dropped — correct, because its cursor
   *  is re-anchored in the same call and the user can page down again. */
  setSessions(list: SessionSummary[], olderSessionsCursor?: string | null): void;
  /** Merge one page of OLDER sessions into the loaded window and advance the cursor.
   *  Merges (never replaces) so the newer pages already on screen survive, and clears
   *  `olderSessionsLoading`. */
  appendOlderSessions(list: SessionSummary[], olderSessionsCursor: string | null): void;
  setOlderSessionsLoading(loading: boolean): void;
  upsertSession(summary: SessionSummary): void;
  removeSession(sessionId: string): void;

  /** Replace the folder list with what `GET /folders` returned, order intact.
   *  The server's answer is the whole truth here — this never merges with what the
   *  loaded sessions happen to mention, or a folder deleted on the server would
   *  live on in the sidebar for as long as one session still pointed at it. */
  setFolders(folders: string[]): void;

  setActive(sessionId: string | null): void;

  setTurns(sessionId: string, model: TurnModel): void;
  applyTailEvent(sessionId: string, event: WireEvent): void;
  setTurnsLoading(sessionId: string, loading: boolean): void;
  prependOlder(sessionId: string, older: TurnModel): void;

  /** Cache a session's fetched detail info (null = fetched, harness reported none);
   *  clears the loading flag. Keyed by id so a repeat `useSessionInfo` reads the cache. */
  setSessionInfo(sessionId: string, info: SessionInfo | null): void;
  setSessionInfoLoading(sessionId: string, loading: boolean): void;

  /** Cache a session's fetched FULL detail (summary + info + harnessConfig); clears the
   *  detail-loading flag. Backs `useManagedSession`. */
  setSessionDetail(sessionId: string, detail: ManagedSessionDetail): void;
  setSessionDetailLoading(sessionId: string, loading: boolean): void;
  /** Optimistically merge a patch into a cached detail's `harnessConfig` (e.g. a
   *  permission-mode change). No-op if the detail isn't cached yet. Returns the prior
   *  `harnessConfig` (or null) so the caller can revert on a failed PUT. */
  patchHarnessConfig(sessionId: string, patch: Partial<HarnessConfig>): HarnessConfig | null;

  /** Replace a session's parked-hook set (the `/hooks/pending` hydration). */
  setPendingHooks(sessionId: string, hooks: PendingHook[]): void;
  /** Insert or refresh one parked hook (an `awaiting_resolution` event, or the revert
   *  of a refused resolve). */
  upsertPendingHook(sessionId: string, hook: PendingHook): void;
  /** Drop one parked hook (a `completed` event, or an optimistic resolve). */
  clearPendingHook(sessionId: string, requestId: string): void;

  /** Record that a session stopped at its spend ceiling. Replaces any halt already
   *  held for that session: raising the ceiling and breaching the new one later is a
   *  different halt with different figures. */
  setBudgetHalt(halt: BudgetHalt): void;
  /** Drop a session's spend halt — the ceiling moved and the session can run again.
   *  No-op when that session has no halt. */
  clearBudgetHalt(sessionId: string): void;

  appendOptimisticUser(sessionId: string, text: string, clientId: string): void;
  /** Remove the optimistic user row `appendOptimisticUser` added, when the send it
   *  was betting on failed. Without this a refused message stays on screen looking
   *  sent. No-op when the row is already gone (the real `user_message` landed and
   *  reconciled it). */
  dropOptimisticUser(sessionId: string, clientId: string): void;

  setFilter(patch: Partial<FilterState>): void;
  openFolder(folder: string): void;
  /** Record async content-search hits for a query. `query` must be the TRIMMED
   *  search string; it is compared against the trimmed live filter, so a late or
   *  stale response can't override a newer search. `truncated` says the backend
   *  had more matches than it returned.
   *
   *  Takes the whole `SearchHit[]`, not just the ids: `match_count` is the only
   *  ranking signal the search endpoint reports, and the sidebar cannot order
   *  content-only hits without it. */
  setContentHits(query: string, hits: SearchHit[], truncated?: boolean): void;
  /** Record that a content search for the TRIMMED `query` has been asked for. Call
   *  it when the query is typed, not when the request leaves — the debounce wait is
   *  part of the wait the user is looking at. `null` means no search is running.
   *  Clears any previous error. */
  startContentSearch(query: string | null): void;
  /** Record that the content search for `query` ended with no hits to fold in:
   *  `error` non-null when it failed, null when it was cancelled before firing.
   *  Ignored unless `query` is still the one in flight, so a late failure can never
   *  clear the search that replaced it. */
  endContentSearch(query: string, error: string | null): void;

  /** Record unsent composer text and persist it. Setting `''` deletes the persisted
   *  copy — an empty box is the absence of a draft, not a draft that is empty. */
  setDraft(sessionId: string, text: string): void;
  setSending(sessionId: string, sending: boolean): void;

  openPending(opts?: NewSessionOpts): PendingSession;
  clearPending(): void;

  /** Cache the harness registry (`GET /harnesses`); clears the loading flag. */
  setHarnesses(list: HarnessMeta[]): void;
  setHarnessesLoading(loading: boolean): void;
  /** Cache the model registry (`GET /models`, enabled rows); clears the loading flag. */
  setModels(list: ModelOption[]): void;
  setModelsLoading(loading: boolean): void;
}

export type ChatStoreApi = StoreApi<ChatState>;

/** One shared empty map for sessions with no parked hook. Reusing the reference keeps
 *  `usePendingPermissions`'s selector stable, so a session that never parks a hook never
 *  re-renders the banner. */
export const EMPTY_HOOKS: ReadonlyMap<string, PendingHook> = new Map();

function getOrInitTail(state: ChatState, sessionId: string): TailState {
  const existing = state.tails.get(sessionId);
  if (existing) return existing;
  return initTailState(sessionId, state.turnsBySession.get(sessionId));
}

/** Options for `createChatStore`. */
export interface CreateChatStoreOptions {
  /** Where composer drafts are persisted. Defaults to the browser's `localStorage`
   *  (and to no persistence anywhere it does not exist — node, SSR, a test). Pass
   *  `null` to turn persistence off explicitly, or a `DraftStorageLike` to point it
   *  somewhere else. */
  draftStorage?: DraftStorageLike | null;
  /** Where the sidebar's filter selection is persisted. Same defaulting as
   *  `draftStorage`, and kept as a separate option so a caller can persist one and
   *  not the other. */
  filterStorage?: WebStorageLike | null;
}

export function createChatStore(options: CreateChatStoreOptions = {}): ChatStoreApi {
  const draftStore = new DraftStore(
    options.draftStorage === undefined ? defaultDraftStorage() : options.draftStorage,
  );
  const filterStore = new FilterStore(
    options.filterStorage === undefined ? defaultWebStorage() : options.filterStorage,
  );
  // Read synchronously, BEFORE the store exists, so the drafts are in the very first
  // state the UI ever sees. An async hydrate would land after the composer is already
  // typeable and would race the user's keystrokes.
  const persistedDrafts = draftStore.load();
  // Same reasoning, and it matters more here: a filter applied one paint late means
  // the list is drawn unfiltered and then rows are pulled out from under a user who
  // has already started reading it. `search` and `folder` are never restored — see
  // filterStorage.ts.
  const persistedFilterAxes = filterStore.load();

  return createStore<ChatState>((set, get) => {
    const actions: ChatActions = {
      setConn(connState) {
        set({ connState });
      },
      setListLoading(listLoading) {
        set({ listLoading });
      },

      setSessions(list, olderSessionsCursor = null) {
        const sessions = new Map<string, SessionSummary>();
        for (const s of list) sessions.set(s.sessionId, s);
        set({
          sessions,
          listLoading: false,
          olderSessionsCursor,
          olderSessionsLoading: false,
        });
      },

      appendOlderSessions(list, olderSessionsCursor) {
        // One Map copy and one folder scan for the whole page — a per-row
        // `upsertSession` loop would do both 100 times over.
        const sessions = new Map(get().sessions);
        for (const s of list) {
          const prev = sessions.get(s.sessionId);
          // A row that arrived live over SSE while the page was in flight is newer
          // than the page; keep the live fields on top.
          sessions.set(s.sessionId, prev ? { ...s, ...prev } : s);
        }
        set({
          sessions,
          olderSessionsCursor,
          olderSessionsLoading: false,
        });
      },

      setOlderSessionsLoading(olderSessionsLoading) {
        set({ olderSessionsLoading });
      },

      upsertSession(summary) {
        const sessions = new Map(get().sessions);
        const prev = sessions.get(summary.sessionId);
        sessions.set(summary.sessionId, prev ? { ...prev, ...summary } : summary);
        set({ sessions });
      },

      removeSession(sessionId) {
        const sessions = new Map(get().sessions);
        if (!sessions.delete(sessionId)) return;
        const turnsBySession = new Map(get().turnsBySession);
        turnsBySession.delete(sessionId);
        const tails = new Map(get().tails);
        tails.delete(sessionId);
        const sessionInfo = new Map(get().sessionInfo);
        sessionInfo.delete(sessionId);
        const sessionInfoLoading = new Set(get().sessionInfoLoading);
        sessionInfoLoading.delete(sessionId);
        const sessionDetail = new Map(get().sessionDetail);
        sessionDetail.delete(sessionId);
        const sessionDetailLoading = new Set(get().sessionDetailLoading);
        sessionDetailLoading.delete(sessionId);
        const pendingHooks = new Map(get().pendingHooks);
        pendingHooks.delete(sessionId);
        // The one authoritative "this session is gone" signal there is, so it is the
        // one place a draft can be dropped for a reason rather than for age. Persist
        // the removal too, or the draft comes straight back on the next reload.
        const drafts = new Map(get().drafts);
        const hadDraft = drafts.delete(sessionId);
        if (hadDraft) draftStore.save(drafts);
        set({
          sessions,
          turnsBySession,
          tails,
          pendingHooks,
          sessionInfo,
          sessionInfoLoading,
          sessionDetail,
          sessionDetailLoading,
          drafts,
          activeId: get().activeId === sessionId ? null : get().activeId,
        });
      },

      setFolders(folders) {
        set({ folders });
      },

      setActive(activeId) {
        set({ activeId });
      },

      setTurns(sessionId, model) {
        const turnsBySession = new Map(get().turnsBySession);
        turnsBySession.set(sessionId, model);
        const tails = new Map(get().tails);
        tails.set(sessionId, initTailState(sessionId, model));
        const moreBySession = new Map(get().moreBySession);
        moreBySession.set(sessionId, model.more);
        const turnsLoading = new Set(get().turnsLoading);
        turnsLoading.delete(sessionId);
        set({ turnsBySession, tails, moreBySession, turnsLoading });
      },

      applyTailEvent(sessionId, event) {
        const state = get();
        // Parked hooks are folded FIRST and independently of the turn reducer. A hook
        // event moves no turn, so the reducer returns the same tail and the early
        // return below would drop it — and with it the only signal that a tool call is
        // frozen waiting on a human.
        const priorHooks = state.pendingHooks.get(sessionId) ?? EMPTY_HOOKS;
        const nextHooks = foldHookEvent(priorHooks, event);
        if (nextHooks !== priorHooks) {
          const pendingHooks = new Map(state.pendingHooks);
          pendingHooks.set(sessionId, nextHooks as Map<string, PendingHook>);
          set({ pendingHooks });
        }
        // A spend halt is folded FIRST for the same reason: the gate interrupts the
        // turn and emits an error event, and an error event that the turn reducer
        // treats as a no-op would hit the early return below and be lost — leaving a
        // session that stopped mid-answer with no visible cause.
        const halt = budgetHaltFromEvent(sessionId, event);
        if (halt) actions.setBudgetHalt(halt);
        let tail = getOrInitTail(state, sessionId);
        // Strip a matching optimistic user row when the real user_message lands,
        // so the two don't double-show (both are harness-sourced, so the OTel
        // annotator won't collapse them). Correlation prefers the client request id,
        // then falls back to a normalized-text match (bug-1 hardening) so a server
        // prompt that came back trimmed/normalized still reconciles.
        if (event.type === 'user_message') {
          tail = stripOptimisticUser(tail, event);
        }
        const next = applyEvent(tail, event);
        if (next === tail) return; // idempotent no-op
        const tails = new Map(state.tails);
        tails.set(sessionId, next);
        const turnsBySession = new Map(state.turnsBySession);
        turnsBySession.set(sessionId, next.model);
        set({ tails, turnsBySession });
      },

      setTurnsLoading(sessionId, loading) {
        const turnsLoading = new Set(get().turnsLoading);
        if (loading) turnsLoading.add(sessionId);
        else turnsLoading.delete(sessionId);
        set({ turnsLoading });
      },

      setSessionInfo(sessionId, info) {
        const sessionInfo = new Map(get().sessionInfo);
        sessionInfo.set(sessionId, info);
        const sessionInfoLoading = new Set(get().sessionInfoLoading);
        sessionInfoLoading.delete(sessionId);
        set({ sessionInfo, sessionInfoLoading });
      },

      setSessionInfoLoading(sessionId, loading) {
        const sessionInfoLoading = new Set(get().sessionInfoLoading);
        if (loading) sessionInfoLoading.add(sessionId);
        else sessionInfoLoading.delete(sessionId);
        set({ sessionInfoLoading });
      },

      setSessionDetail(sessionId, detail) {
        const sessionDetail = new Map(get().sessionDetail);
        sessionDetail.set(sessionId, detail);
        const sessionDetailLoading = new Set(get().sessionDetailLoading);
        sessionDetailLoading.delete(sessionId);
        set({ sessionDetail, sessionDetailLoading });
      },

      setSessionDetailLoading(sessionId, loading) {
        const sessionDetailLoading = new Set(get().sessionDetailLoading);
        if (loading) sessionDetailLoading.add(sessionId);
        else sessionDetailLoading.delete(sessionId);
        set({ sessionDetailLoading });
      },

      patchHarnessConfig(sessionId, patch) {
        const prev = get().sessionDetail.get(sessionId);
        if (!prev) return null;
        const prevConfig = prev.harnessConfig;
        const nextConfig: HarnessConfig = { ...(prevConfig ?? {}), ...patch };
        const sessionDetail = new Map(get().sessionDetail);
        sessionDetail.set(sessionId, { ...prev, harnessConfig: nextConfig });
        set({ sessionDetail });
        return prevConfig;
      },

      prependOlder(sessionId, older) {
        const cur = get().turnsBySession.get(sessionId);
        if (!cur) {
          get().actions.setTurns(sessionId, older);
          return;
        }
        const entries = { ...older.entries, ...cur.entries };
        const seen = new Set(cur.turns.map((t) => t.id));
        const turns: Turn[] = [...older.turns.filter((t) => !seen.has(t.id)), ...cur.turns];
        const merged: TurnModel = {
          sessionId,
          turns,
          entries,
          validator: cur.validator,
          more: older.more,
        };
        const turnsBySession = new Map(get().turnsBySession);
        turnsBySession.set(sessionId, merged);
        const tails = new Map(get().tails);
        tails.set(sessionId, initTailState(sessionId, merged));
        const moreBySession = new Map(get().moreBySession);
        moreBySession.set(sessionId, older.more);
        set({ turnsBySession, tails, moreBySession });
      },

      setPendingHooks(sessionId, hooks) {
        const pendingHooks = new Map(get().pendingHooks);
        const forSession = new Map<string, PendingHook>();
        for (const hook of hooks) forSession.set(hook.requestId, hook);
        pendingHooks.set(sessionId, forSession);
        set({ pendingHooks });
      },

      upsertPendingHook(sessionId, hook) {
        const pendingHooks = new Map(get().pendingHooks);
        const forSession = new Map(pendingHooks.get(sessionId) ?? EMPTY_HOOKS);
        forSession.set(hook.requestId, hook);
        pendingHooks.set(sessionId, forSession);
        set({ pendingHooks });
      },

      clearPendingHook(sessionId, requestId) {
        const forSession = get().pendingHooks.get(sessionId);
        if (!forSession?.has(requestId)) return;
        const next = new Map(forSession);
        next.delete(requestId);
        const pendingHooks = new Map(get().pendingHooks);
        pendingHooks.set(sessionId, next);
        set({ pendingHooks });
      },

      appendOptimisticUser(sessionId, text, clientId) {
        const state = get();
        const tail = getOrInitTail(state, sessionId);
        const next = appendOptimistic(tail, text, clientId);
        const tails = new Map(state.tails);
        tails.set(sessionId, next);
        const turnsBySession = new Map(state.turnsBySession);
        turnsBySession.set(sessionId, next.model);
        set({ tails, turnsBySession });
      },

      dropOptimisticUser(sessionId, clientId) {
        const state = get();
        const tail = state.tails.get(sessionId);
        if (!tail) return;
        const next = removeOptimistic(tail, clientId);
        if (next === tail) return;
        const tails = new Map(state.tails);
        tails.set(sessionId, next);
        const turnsBySession = new Map(state.turnsBySession);
        turnsBySession.set(sessionId, next.model);
        set({ tails, turnsBySession });
      },

      setBudgetHalt(halt) {
        const budgetHalts = new Map(get().budgetHalts);
        budgetHalts.set(halt.sessionId, halt);
        set({ budgetHalts });
      },

      clearBudgetHalt(sessionId) {
        const state = get();
        if (!state.budgetHalts.has(sessionId)) return;
        const budgetHalts = new Map(state.budgetHalts);
        budgetHalts.delete(sessionId);
        set({ budgetHalts });
      },

      setFilter(patch) {
        const filter = { ...get().filter, ...patch };
        // A changed search query invalidates the prior content-search hits until
        // the async augmentation returns for the new query (fails safe: local name
        // matching still runs instantly).
        const nextState: Partial<ChatState> = { filter };
        if (patch.search !== undefined) {
          const cur = get().contentHits;
          // Trimmed on both sides: `contentHits.query` is always trimmed, so an
          // untrimmed compare invalidated a still-valid hit set on every keystroke
          // that only added whitespace.
          if (!cur || cur.query !== filter.search.trim()) nextState.contentHits = null;
        }
        set(nextState);
        // Persist only when the patch actually named a persisted axis. Keying off the
        // PATCH rather than diffing the result is what keeps every keystroke in the
        // search box from rewriting the filter record — search is not persisted, and
        // a save per keystroke would be a stringify per keystroke for no change at all.
        if (PERSISTED_FILTER_AXES.some((axis) => patch[axis] !== undefined)) {
          filterStore.save(filter);
        }
      },

      openFolder(folder) {
        set({ filter: { ...get().filter, folder } });
      },

      setContentHits(query, hits, truncated = false) {
        // Drop a stale response whose query no longer matches the live filter.
        // `query` is trimmed by the caller, so trim this side too — comparing it
        // raw dropped the hits for any query the user typed with a stray space.
        if (get().filter.search.trim() !== query) return;
        // Keyed by session id, keeping the count. Duplicate ids collapse the same
        // way the old Set collapsed them; last one wins, which for a sorted list
        // is the smaller count and is the conservative read.
        const matchCountBySessionId = new Map<string, number>();
        for (const h of hits) matchCountBySessionId.set(h.sessionId, h.matchCount);
        // Hits landing ends the search they were asked for, and clears any failure
        // recorded for it. Both are unconditional because the drop above has already
        // established that `query` IS the live query — a second guard on
        // `contentSearchInFlight` was tried here and proved unreachable.
        //
        // Clearing the error is not redundant with `startContentSearch`. A query can
        // have two requests out at once (a trailing space re-fires it under the same
        // trimmed query); if the first fails and the second succeeds, this is the only
        // thing that takes the failure notice back down.
        set({
          contentHits: {
            query,
            matchCountBySessionId,
            hitCount: matchCountBySessionId.size,
            truncated,
          },
          contentSearchInFlight: null,
          contentSearchError: null,
        });
      },

      startContentSearch(query) {
        set({ contentSearchInFlight: query, contentSearchError: null });
      },

      endContentSearch(query, error) {
        if (get().contentSearchInFlight !== query) return;
        set({ contentSearchInFlight: null, contentSearchError: error });
      },

      setDraft(sessionId, text) {
        const drafts = new Map(get().drafts);
        drafts.set(sessionId, text);
        set({ drafts });
        // Synchronous, on every keystroke. See draftStorage.ts for why this is not
        // debounced: the words at risk are the ones typed just before the reload.
        draftStore.save(drafts);
      },

      setSending(sessionId, sending) {
        const s = new Set(get().sending);
        if (sending) s.add(sessionId);
        else s.delete(sessionId);
        set({ sending: s });
      },

      openPending(opts) {
        // Absent keys, not `undefined` ones: `'instanceId' in pending` is what the
        // create path reads to decide whether a target was chosen at all.
        // `maxBudget` and `disabledTools` test `!== undefined` rather than
        // truthiness — 0 (no ceiling) and [] (disable nothing) are both real
        // answers a truthiness check would silently drop back to "inherit".
        const pending: PendingSession = {
          clientId: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ...(opts?.instanceId ? { instanceId: opts.instanceId } : {}),
          ...(opts?.harness ? { harness: opts.harness } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.effort ? { effort: opts.effort } : {}),
          ...(opts?.maxBudget !== undefined ? { maxBudget: opts.maxBudget } : {}),
          ...(opts?.disabledTools !== undefined ? { disabledTools: opts.disabledTools } : {}),
        };
        set({ pending, activeId: null });
        return pending;
      },

      clearPending() {
        set({ pending: null });
      },

      setHarnesses(list) {
        set({ harnesses: list, harnessesLoading: false });
      },
      setHarnessesLoading(harnessesLoading) {
        set({ harnessesLoading });
      },
      setModels(list) {
        set({ models: list, modelsLoading: false });
      },
      setModelsLoading(modelsLoading) {
        set({ modelsLoading });
      },
    };

    return {
      sessions: new Map(),
      turnsBySession: new Map(),
      sessionInfo: new Map(),
      sessionInfoLoading: new Set(),
      sessionDetail: new Map(),
      sessionDetailLoading: new Set(),
      tails: new Map(),
      pendingHooks: new Map(),
      budgetHalts: new Map(),
      activeId: null,
      filter: { ...EMPTY_FILTER, ...persistedFilterAxes },
      contentHits: null,
      contentSearchInFlight: null,
      contentSearchError: null,
      folders: [],
      connState: 'idle',
      listLoading: false,
      olderSessionsCursor: null,
      olderSessionsLoading: false,
      turnsLoading: new Set(),
      moreBySession: new Map(),
      drafts: persistedDrafts,
      sending: new Set(),
      pending: null,
      harnesses: null,
      harnessesLoading: false,
      models: null,
      modelsLoading: false,
      actions,
    };
  });
}

// --- optimistic-entry helpers (live-tail only) ---

function appendOptimistic(tail: TailState, text: string, clientId: string): TailState {
  const entryId = `optim_${clientId}`;
  const turnId = `optimturn_${clientId}`;
  const nowIso = new Date().toISOString();
  const maxEventId = tail.model.validator.maxEventId;
  const entry: Entry = {
    id: entryId,
    turnId,
    role: 'user',
    kind: 'text',
    source: 'harness',
    eventId: maxEventId + 0.5, // orders after the last real event, before the next
    ts: nowIso,
    text,
    duplicate: false,
    primary: true,
    raw: { optimistic: true, clientId },
  };
  const entries = { ...tail.model.entries, [entryId]: entry };
  const turn: Turn = { id: turnId, role: 'user', ts: nowIso, entryIds: [entryId] };
  const turns = [...tail.model.turns, turn];
  const model: TurnModel = { ...tail.model, entries, turns };
  const turnIndex = new Map(tail.turnIndex);
  turnIndex.set(turnId, turns.length - 1);
  return { ...tail, model, turnIndex };
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Reconcile the optimistic user row against the canonical `user_message` event.
 * Bug-1 hardening: correlate by `client_request_id` FIRST (an exact, id-based
 * match), then fall back to a NORMALIZED text match (trim + collapse whitespace)
 * so a server prompt echoed back trimmed/normalized still collapses the optimistic
 * copy instead of leaving both rows alive. The empty-text case is guarded — a
 * canonical event with no text is never matched against an optimistic row by text,
 * which would otherwise drop an unrelated row or leave both alive.
 */
function stripOptimisticUser(tail: TailState, event: WireEvent): TailState {
  const clientId = event.data.client_request_id;
  const normText = normalizeText(event.data.result?.text ?? '');

  let removedId: string | null = null;
  // 1. Prefer an id-based correlation when the server echoes the client request id.
  if (clientId) {
    for (const [id, entry] of Object.entries(tail.model.entries)) {
      const raw = entry.raw as { optimistic?: boolean; clientId?: string } | undefined;
      if (raw?.optimistic && raw.clientId === clientId) {
        removedId = id;
        break;
      }
    }
  }
  // 2. Fall back to a normalized-text match, guarding empty text (no blind match).
  if (!removedId && normText) {
    for (const [id, entry] of Object.entries(tail.model.entries)) {
      const raw = entry.raw as { optimistic?: boolean } | undefined;
      if (raw?.optimistic && normalizeText(entry.text ?? '') === normText) {
        removedId = id;
        break;
      }
    }
  }
  if (!removedId) return tail;
  return removeEntryAndItsTurn(tail, removedId);
}

/** Drop the optimistic row for `clientId`, or report the tail unchanged when there is
 *  none. The id-based half of `stripOptimisticUser`, addressed directly: the caller
 *  here IS the code that minted the client id, so there is nothing to correlate. */
function removeOptimistic(tail: TailState, clientId: string): TailState {
  const entryId = `optim_${clientId}`;
  if (!tail.model.entries[entryId]) return tail;
  return removeEntryAndItsTurn(tail, entryId);
}

/** Remove one entry and the turn it was the whole of, re-deriving the turn index.
 *  Shared by the reconcile path (the real message landed) and the failure path (the
 *  send was refused), so the two can never drift into removing it differently. */
function removeEntryAndItsTurn(tail: TailState, entryId: string): TailState {
  const entries = { ...tail.model.entries };
  const removed = entries[entryId];
  delete entries[entryId];
  const turns = tail.model.turns.filter((t) => t.id !== removed?.turnId);
  const turnIndex = new Map<string, number>();
  turns.forEach((t, i) => turnIndex.set(t.id, i));
  const model: TurnModel = { ...tail.model, entries, turns };
  return { ...tail, model, turnIndex };
}
