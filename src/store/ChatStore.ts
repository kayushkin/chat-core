import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  Entry,
  HarnessConfig,
  HarnessMeta,
  ManagedSessionDetail,
  ModelOption,
  PendingHook,
  SessionInfo,
  SessionSummary,
  Turn,
  TurnModel,
} from '../net/types.js';
import type { WireEvent } from '../net/wireEvents.js';
import { applyEvent, initTailState, type TailState } from '../reduce/TurnReducer.js';
import { foldHookEvent } from './pendingHooks.js';

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

/** A pending (not-yet-created) session pane — 0 network until first send. `model` /
 *  `effort` are the controls-bar pre-start settings chosen before the first send; they
 *  are applied via `POST /sessions/{id}/config` right after the real session is lazily
 *  created (bridge-ui parity — create takes no model/effort). */
export interface PendingSession {
  clientId: string;
  instanceId?: string;
  harness?: string;
  model?: string;
  effort?: string;
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
  ids: Set<string>;
  /** How many hits the backend returned for `query` — `ids.size`, kept explicitly
   *  because it is a count of what the SERVER found, while the number of rows the
   *  list can actually paint is bounded by the loaded window and is always ≤ this. */
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
  activeId: string | null;
  filter: FilterState;
  /** Content-search hits for the current `filter.search`, or null when none have
   *  been fetched (or the query changed and the prior set was invalidated). */
  contentHits: ContentHits | null;
  /** Known folder names, maintained from session upserts. */
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

  appendOptimisticUser(sessionId: string, text: string, clientId: string): void;

  setFilter(patch: Partial<FilterState>): void;
  openFolder(folder: string): void;
  /** Record async content-search hits for a query. `query` must be the TRIMMED
   *  search string; it is compared against the trimmed live filter, so a late or
   *  stale response can't override a newer search. `truncated` says the backend
   *  had more matches than it returned. */
  setContentHits(query: string, ids: string[], truncated?: boolean): void;

  setDraft(sessionId: string, text: string): void;
  setSending(sessionId: string, sending: boolean): void;

  openPending(opts?: { instanceId?: string; harness?: string; model?: string; effort?: string }): PendingSession;
  clearPending(): void;

  /** Cache the harness registry (`GET /harnesses`); clears the loading flag. */
  setHarnesses(list: HarnessMeta[]): void;
  setHarnessesLoading(loading: boolean): void;
  /** Cache the model registry (`GET /models`, enabled rows); clears the loading flag. */
  setModels(list: ModelOption[]): void;
  setModelsLoading(loading: boolean): void;
}

export type ChatStoreApi = StoreApi<ChatState>;

function collectFolders(sessions: Iterable<SessionSummary>): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    if (s.folderName) set.add(s.folderName);
  }
  return [...set].sort();
}

/** One shared empty map for sessions with no parked hook. Reusing the reference keeps
 *  `usePendingPermissions`'s selector stable, so a session that never parks a hook never
 *  re-renders the banner. */
export const EMPTY_HOOKS: ReadonlyMap<string, PendingHook> = new Map();

function getOrInitTail(state: ChatState, sessionId: string): TailState {
  const existing = state.tails.get(sessionId);
  if (existing) return existing;
  return initTailState(sessionId, state.turnsBySession.get(sessionId));
}

export function createChatStore(): ChatStoreApi {
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
          folders: collectFolders(sessions.values()),
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
          folders: collectFolders(sessions.values()),
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
        set({ sessions, folders: collectFolders(sessions.values()) });
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
        set({
          sessions,
          turnsBySession,
          tails,
          pendingHooks,
          sessionInfo,
          sessionInfoLoading,
          sessionDetail,
          sessionDetailLoading,
          folders: collectFolders(sessions.values()),
          activeId: get().activeId === sessionId ? null : get().activeId,
        });
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
      },

      openFolder(folder) {
        set({ filter: { ...get().filter, folder } });
      },

      setContentHits(query, ids, truncated = false) {
        // Drop a stale response whose query no longer matches the live filter.
        // `query` is trimmed by the caller, so trim this side too — comparing it
        // raw dropped the hits for any query the user typed with a stray space.
        if (get().filter.search.trim() !== query) return;
        const set_ = new Set(ids);
        set({ contentHits: { query, ids: set_, hitCount: set_.size, truncated } });
      },

      setDraft(sessionId, text) {
        const drafts = new Map(get().drafts);
        drafts.set(sessionId, text);
        set({ drafts });
      },

      setSending(sessionId, sending) {
        const s = new Set(get().sending);
        if (sending) s.add(sessionId);
        else s.delete(sessionId);
        set({ sending: s });
      },

      openPending(opts) {
        const pending: PendingSession = {
          clientId: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ...(opts?.instanceId ? { instanceId: opts.instanceId } : {}),
          ...(opts?.harness ? { harness: opts.harness } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.effort ? { effort: opts.effort } : {}),
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
      activeId: null,
      filter: { ...EMPTY_FILTER },
      contentHits: null,
      folders: [],
      connState: 'idle',
      listLoading: false,
      olderSessionsCursor: null,
      olderSessionsLoading: false,
      turnsLoading: new Set(),
      moreBySession: new Map(),
      drafts: new Map(),
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
  const entries = { ...tail.model.entries };
  const removed = entries[removedId];
  delete entries[removedId];
  const turns = tail.model.turns.filter((t) => t.id !== removed?.turnId);
  const turnIndex = new Map<string, number>();
  turns.forEach((t, i) => turnIndex.set(t.id, i));
  const model: TurnModel = { ...tail.model, entries, turns };
  return { ...tail, model, turnIndex };
}
