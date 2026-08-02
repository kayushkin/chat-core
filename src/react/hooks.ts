import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type {
  Entry,
  HookResolveInput,
  ManagedSessionDetail,
  ModelOption,
  PendingHook,
  SessionConfig,
  SessionInfo,
  SessionSummary,
  Turn,
} from '../net/types.js';
import {
  EMPTY_HOOKS,
  type ChatActions,
  type ConnState,
  type FilterState,
  type PendingSession,
} from '../store/ChatStore.js';
import { changeSessionPermissionMode } from '../store/permissionMode.js';
import { resolvePendingHook } from '../store/pendingHooks.js';
import { budgetHaltFromRefusal, type BudgetHalt } from '../store/budgetHalt.js';
import {
  activeSummaryEffective,
  contextUsage,
  effectiveState,
  harnessCapabilities,
  modelsForHarness,
  selectContentSearchReach,
  selectFacets,
  sessionCost,
  sourcesForEntry,
  turnsFor,
  visibleCount,
  visibleSessions,
  visibleEntryIdsFor,
  type ContentSearchReach,
  type ContextUsage,
  type Facets,
  type SessionCost,
} from '../store/selectors.js';
import { useChatContext } from './context.js';

// All hooks read via Zustand selector subscriptions so only components whose
// slice changed re-render. select() / filter changes / newSession / archive
// NEVER await the network on the path that updates the UI — a fetch, if needed,
// is fired in the background.

/** How long to wait after the last keystroke before asking the backend for
 *  content hits. Only the NETWORK half of search is delayed — the local display-name
 *  filter still runs on the keystroke, so the list never feels slower.
 *
 *  `GET /sessions/search` is a full-text scan over every materialized transcript on
 *  the box; it was previously fired once per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

function useActions(): ChatActions {
  const { store } = useChatContext();
  return useStore(store, (s) => s.actions);
}

/** Liveness of the global session-list SSE stream, as `SyncEngine` reports it.
 *
 *  This is the only signal that separates "still connecting" from "you genuinely have
 *  no sessions", and the only one that says the client has stopped receiving updates.
 *  Without it a cold load and an empty account render identically, and the composer
 *  accepts a message into a stream that will never carry the reply back.
 *
 *  The four values are not evenly likely. `'idle'` is the window between mount and
 *  `SyncEngine.start()` — the boot prime runs first, so a slow boot sits here.
 *  `'connecting'` covers both the first attach and every backoff reconnect, so a
 *  dropped stream reads as connecting, never as closed. `'closed'` is set only by
 *  `SyncEngine.stop()`, i.e. on unmount. So the honest test for "updates are flowing"
 *  is `=== 'open'`, not `!== 'closed'`. */
export function useConnState(): ConnState {
  const { store } = useChatContext();
  return useStore(store, (s) => s.connState);
}

/** Sidebar list, already filtered + grouped + sorted by the current filter/folder.
 *  `effectiveState(sessionId)` returns the tail-reconciled state for a row's status
 *  indicator: a session the server still reports as running/holding but whose warm
 *  tail is terminal reads as completed/failed, so a stale spinner self-heals on open
 *  (F1). The function's identity changes when the tails or session maps change, so a
 *  settling tail re-renders the affected rows.
 *
 *  The list is ONE page deep on boot. `moreSessions` is true while the server holds
 *  older sessions the sidebar has not loaded, and `loadOlderSessions()` pulls the next
 *  page — the sidebar must offer both, or every session past the first page is
 *  unreachable. Note `total` counts the LOADED-and-filter-passing rows, never a server
 *  total: the summary endpoint reports no count, so "at least one more page" is the
 *  strongest claim available.
 *
 *  Filtering and the chip facets are computed over the loaded window only, so paging
 *  widens what a filter can match — that is the intended relationship, and why the
 *  affordance must stay reachable even when the current filter matches nothing. */
export function useSessionList(): {
  groups: { folder: string; sessions: SessionSummary[] }[];
  total: number;
  loading: boolean;
  effectiveState: (sessionId: string) => string;
  facets: Facets;
  moreSessions: boolean;
  loadingOlderSessions: boolean;
  loadOlderSessions: () => void;
} {
  const { store, prefetcher } = useChatContext();
  const groups = useStore(store, visibleSessions);
  const total = useStore(store, visibleCount);
  const loading = useStore(store, (s) => s.listLoading);
  const moreSessions = useStore(store, (s) => s.olderSessionsCursor !== null);
  const loadingOlderSessions = useStore(store, (s) => s.olderSessionsLoading);
  const loadOlderSessions = useCallback(() => {
    void prefetcher.loadOlderSessions();
  }, [prefetcher]);
  // Cross-axis facet counts over the FULL loaded set (independent of the active filter),
  // so the sidebar can render every available option with its count. Memoized on the
  // sessions Map identity (see selectFacets).
  const facets = useStore(store, selectFacets);
  const turnsBySession = useStore(store, (s) => s.turnsBySession);
  const sessions = useStore(store, (s) => s.sessions);
  const effState = useCallback(
    (sessionId: string) => effectiveState(store.getState(), sessionId),
    [store, turnsBySession, sessions],
  );
  return {
    groups,
    total,
    loading,
    effectiveState: effState,
    facets,
    moreSessions,
    loadingOlderSessions,
    loadOlderSessions,
  };
}

/** Active session id + a synchronous setter. */
export function useActiveSession(): {
  id: string | null;
  select: (id: string) => void;
  summary: SessionSummary | null;
} {
  const { store, api, prefetcher } = useChatContext();
  const id = useStore(store, (s) => s.activeId);
  // Reconciled against the warm tail so a stale running/holding state clears on open.
  const summary = useStore(store, activeSummaryEffective);
  const actions = useActions();

  const select = useCallback(
    (nextId: string) => {
      // Synchronous: swap the active id and render from cache immediately.
      actions.setActive(nextId);
      actions.clearPending();
      // Background: warm a cold session; the store update is what re-renders.
      const state = store.getState();
      if (!state.turnsBySession.has(nextId) && !state.turnsLoading.has(nextId)) {
        actions.setTurnsLoading(nextId, true);
        void api
          .getMessages(nextId, { limit: 30 })
          .then((resp) => actions.setTurns(nextId, resp.model))
          .catch(() => actions.setTurnsLoading(nextId, false));
      }
      void prefetcher; // hover prefetch may already have warmed it.
    },
    [actions, api, store, prefetcher],
  );

  return { id, select, summary };
}

/** The pending (not-yet-created) session pane, or null when none is open.
 *
 *  `activeId === null` covers two different situations that a UI has to draw
 *  differently: nothing is selected, and a new chat is open but has not been sent yet.
 *  `openPending` already sets `activeId` to null, so without this selector the two are
 *  indistinguishable and a freshly opened new chat renders as an empty pane.
 *
 *  The value is the store's, not a guess: it carries the instance/harness the first
 *  send will create the session on, so a header can name the target BEFORE the session
 *  exists. It is null again the moment the real session is created (`clearPending`). */
export function usePendingSession(): PendingSession | null {
  const { store } = useChatContext();
  return useStore(store, (s) => s.pending);
}

/** Turns for a session, honoring the collapsed/raw view. */
export function useTurns(
  sessionId: string | null,
  view: 'turns' | 'raw' = 'turns',
): {
  turns: Turn[];
  entries: Record<string, Entry>;
  visibleEntryIds: (turnId: string) => string[];
  sourcesFor: (entryId: string) => Entry[];
  loading: boolean;
  more: boolean;
  loadOlder: () => void;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const model = useStore(store, (s) => turnsFor(s, sessionId));
  const loading = useStore(store, (s) => (sessionId ? s.turnsLoading.has(sessionId) : false));
  const more = useStore(store, (s) => (sessionId ? (s.moreBySession.get(sessionId) ?? false) : false));

  // Cold session: trigger a background tail fetch. Never throws on the render
  // path; the store update paints the result.
  useEffect(() => {
    if (!sessionId) return;
    const state = store.getState();
    if (state.turnsBySession.has(sessionId)) return;
    if (state.turnsLoading.has(sessionId)) return;
    actions.setTurnsLoading(sessionId, true);
    void api
      .getMessages(sessionId, { limit: 30 })
      .then((resp) => actions.setTurns(sessionId, resp.model))
      .catch(() => actions.setTurnsLoading(sessionId, false));
  }, [sessionId, store, api, actions]);

  const turns = model?.turns ?? EMPTY_TURNS;
  const entries = model?.entries ?? EMPTY_ENTRIES;

  const visibleEntryIds = useCallback(
    (turnId: string) => visibleEntryIdsFor(model, turnId, view),
    [model, view],
  );
  const sourcesFor = useCallback((entryId: string) => sourcesForEntry(model, entryId), [model]);

  const loadOlder = useCallback(() => {
    if (!sessionId || !model || !model.more) return;
    // Cursor = the oldest entry's eventId; page strictly older than it.
    let oldest = Number.POSITIVE_INFINITY;
    for (const e of Object.values(model.entries)) {
      if (e.eventId < oldest) oldest = e.eventId;
    }
    if (!Number.isFinite(oldest)) return;
    void api
      .getMessages(sessionId, { limit: 30, before: Math.floor(oldest) })
      .then((resp) => actions.prependOlder(sessionId, resp.model))
      .catch(() => {});
  }, [sessionId, model, api, actions]);

  return { turns, entries, visibleEntryIds, sourcesFor, loading, more, loadOlder };
}

/** The server-reported session states in which POST /sessions/{id}/resume actually
 *  succeeds — i.e. the client-visible proxy for "this session has no live harness
 *  process".
 *
 *  The gate is the server's to define and it has defined it: `handleResumeSession`
 *  (llm-bridge-server `internal/server/sessions.go`) consults the live process
 *  registry, NOT the denormalised state string — a session with a process is
 *  "already running" and gets a 409, one without is resumable whatever its state
 *  reads. `TestResumeSession_AlreadyRunning` pins that 409. These five states are
 *  the ones a session can only reach by its process being gone.
 *
 *  Two things this set is deliberately NOT:
 *
 *  - It is not `paused`. Nothing on this box emits `msg.SessionPaused`: the server's
 *    derivation only passes the value through if a manager injects it, and no site
 *    does. Zero of the 500 most recent live sessions carry it (measured 2026-08-02).
 *    A control gated on `paused` is a control that never appears.
 *  - It is not "the user hit stop". Interrupt leaves the process registered
 *    (`Manager.Stop` calls `proc.Interrupt()`; only `Kill` and process exit remove
 *    it from the map), so an interrupted session is idle WITH a live process and
 *    resuming it is exactly the 409 case.
 *
 *  Every other state is ambiguous about the process and so is excluded, each for a
 *  reason that was checked rather than assumed:
 *
 *  - `idle` sits between a live process waiting for the next turn and a dead one
 *    the state row never caught up with. Offering Resume on the live half would
 *    surface a routine 409 as an error.
 *  - `completed` is written both by a PTY child exiting AND by "mark done"
 *    (`handleSetSessionFolder`), which never touches the process.
 *  - `error` and `rate_limited` are mid-life states — the process is still there.
 *
 *  None of those need a Resume button anyway: `handleSendMessage` starts a process
 *  when the registry has none, so a dead session of any state revives by being sent
 *  to. Resume is the way to bring one back WITHOUT putting words in its mouth.
 *
 *  When `e1732f61` (SessionPaused on interrupt) is decided and the manager starts
 *  emitting it, `paused` joins this set; nothing else here changes. */
const RESUMABLE_STATES = new Set<string>(['aborted', 'disconnected']);

/** Composer + turn controls for a session (or the pending/new pane).
 *
 *  `stop()` interrupts the running turn (POST /sessions/{id}/interrupt). It is a
 *  LOUD control: `ApiClient.interrupt` throws on any non-2xx (e.g. the 409 the
 *  server returns while a tool still holds the turn), and `stop()` sets `error` AND
 *  rethrows rather than optimistically marking the session idle — a failed stop must
 *  be visible, never swallowed into a fake-idle. `interrupting` is true for the
 *  duration of the request; `paused` reflects a parked/held session state (checked
 *  as the explicit 'paused' value, never a bare `state === 'running'` — `tool_running`
 *  is also busy, the §5 enum trap).
 *
 *  `resume()` restarts a session whose harness process is gone (POST
 *  /sessions/{id}/resume), and is LOUD on the same terms as `stop()`. `resumable`
 *  says when it will actually work — see RESUMABLE_STATES below for why that is
 *  NOT `paused`. */
export function useComposer(sessionId: string | null): {
  send: (text: string) => void;
  draft: string;
  setDraft: (t: string) => void;
  sending: boolean;
  stop: () => Promise<void>;
  interrupting: boolean;
  paused: boolean;
  resume: () => Promise<void>;
  resuming: boolean;
  resumable: boolean;
  error: string | null;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const key = sessionId ?? PENDING_DRAFT_KEY;
  const draft = useStore(store, (s) => s.drafts.get(key) ?? '');
  const sending = useStore(store, (s) => (sessionId ? s.sending.has(sessionId) : false));
  const state = useStore(store, (s) => (sessionId ? s.sessions.get(sessionId)?.state : undefined));
  const paused = state === 'paused';
  const resumable = !!sessionId && !!state && RESUMABLE_STATES.has(state);
  const [interrupting, setInterrupting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDraft = useCallback((t: string) => actions.setDraft(key, t), [actions, key]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    setInterrupting(true);
    setError(null);
    try {
      // Throws on non-2xx (incl. the 409 "nothing was stopped"). Do NOT mark the
      // session idle on failure — surface the error and rethrow.
      await api.interrupt(sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setInterrupting(false);
    }
  }, [api, sessionId]);

  const resume = useCallback(async () => {
    if (!sessionId) return;
    setResuming(true);
    setError(null);
    try {
      // LOUD on the same terms as stop(): `ApiClient.resume` throws on any non-2xx
      // — the 409 when the session turns out to have a live process after all, the
      // 500 when it is bound to no instance and so cannot be respawned. Surface it
      // and rethrow; never pretend the session came back.
      await api.resume(sessionId);
    } catch (e) {
      // A session that spent its ceiling does not come back by being resumed — the
      // server refuses this with the same 402 as a send. Record the halt so the
      // banner names the one thing that will fix it.
      const halt = budgetHaltFromRefusal(sessionId, e);
      if (halt) actions.setBudgetHalt(halt);
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setResuming(false);
    }
  }, [api, actions, sessionId]);

  /** What a failed send undoes, in one place so the create path and the ordinary
   *  path fail identically.
   *
   *  A send used to fail invisibly: the POST's rejection went into a `.finally()`
   *  with no `.catch`, and the create path had a bare `.catch(() => {})`. The
   *  optimistic user row stayed on screen looking sent, the draft stayed cleared, and
   *  the spend-ceiling 402 — the one refusal that tells the user exactly what to do
   *  about it — was thrown away before anything could read it.
   *
   *  So: put the text back in the box, take the row that was never sent back off the
   *  screen, record a spend halt when that is what this was, and say what happened.
   *  The draft is only restored when the box is still empty, so a user who typed the
   *  next message while this one was in flight does not lose it. */
  const failSend = useCallback(
    (targetSessionId: string | null, clientId: string | null, text: string, thrown: unknown) => {
      if (targetSessionId && clientId) actions.dropOptimisticUser(targetSessionId, clientId);
      if ((store.getState().drafts.get(key) ?? '') === '') actions.setDraft(key, text);
      const halt = targetSessionId ? budgetHaltFromRefusal(targetSessionId, thrown) : null;
      if (halt) actions.setBudgetHalt(halt);
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    },
    [actions, store, key],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      actions.setDraft(key, '');
      setError(null);

      // Lazy-create a real session for the pending pane on first send.
      if (!sessionId) {
        const pending = store.getState().pending;
        const clientId = `c_${Date.now()}`;
        let createdId: string | null = null;
        void api
          .createSession(pending ? { instanceId: pending.instanceId, harness: pending.harness } : undefined)
          .then((created) => {
            const newId = created.sessionId;
            createdId = newId;
            actions.setActive(newId);
            actions.clearPending();
            // Apply the controls-bar pre-start model/effort via POST /config right after
            // create (bridge-ui parity — create itself takes no model/effort). Best-effort
            // on this optimistic, non-blocking send path: a failure must not strand the
            // message. `useSessionControls().setConfig` is the LOUD path for a live change.
            if (pending?.model || pending?.effort) {
              void api
                .setConfig(newId, { model: pending.model, effort: pending.effort })
                .catch(() => {});
            }
            actions.appendOptimisticUser(newId, trimmed, clientId);
            actions.setSending(newId, true);
            return api.send(newId, trimmed).finally(() => actions.setSending(newId, false));
          })
          .catch((e: unknown) => failSend(createdId, createdId ? clientId : null, trimmed, e));
        return;
      }

      // Optimistic: show the user's text instantly, then POST + reconcile.
      const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      actions.appendOptimisticUser(sessionId, trimmed, clientId);
      actions.setSending(sessionId, true);
      void api
        .send(sessionId, trimmed)
        .catch((e: unknown) => failSend(sessionId, clientId, trimmed, e))
        .finally(() => actions.setSending(sessionId, false));
    },
    [actions, api, store, sessionId, key, failSend],
  );

  return {
    send,
    draft,
    setDraft,
    sending,
    stop,
    interrupting,
    paused,
    resume,
    resuming,
    resumable,
    error,
  };
}

/** Filters + folders (client-side; switching is sub-10ms).
 *
 *  `set({ search })` matches the display name INSTANTLY and locally. Content search
 *  (C6) is an async augmentation: the same query is also sent to the backend
 *  (GET /sessions/search) and its hit ids are folded into the list path when they
 *  arrive, so the filter matches transcript text too — without ever blocking the
 *  local name filter on the network. */
export function useFilters(): {
  filter: FilterState;
  set: (patch: Partial<FilterState>) => void;
  openFolder: (folder: string) => void;
  /** How much of the active content search the list can actually paint, or null
   *  when no content search is active. Non-null with `hiddenHitCount > 0` means
   *  the sidebar is showing fewer results than the backend found — surface it,
   *  because the shortfall is otherwise invisible. */
  contentSearchReach: ContentSearchReach | null;
} {
  const { store, api } = useChatContext();
  const filter = useStore(store, (s) => s.filter);
  const contentSearchReach = useStore(store, selectContentSearchReach);
  const actions = useActions();
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel a pending search when the component goes away, so a debounced request
  // never fires into an unmounted tree.
  useEffect(
    () => () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    },
    [],
  );
  const set = useCallback(
    (patch: Partial<FilterState>) => {
      actions.setFilter(patch); // instant/local — never awaits the network.
      if (patch.search !== undefined) {
        const q = patch.search.trim();
        // Debounced: this used to fire one GET /sessions/search per KEYSTROKE,
        // so typing a ten-character query cost ten full-text scans of every
        // transcript and left ten responses racing to land. The local name
        // filter above is unaffected and stays instant.
        if (searchDebounce.current) clearTimeout(searchDebounce.current);
        if (q) {
          searchDebounce.current = setTimeout(() => {
            // Async augmentation; setContentHits ignores a stale response.
            void api
              .search(q)
              .then((r) => actions.setContentHits(q, r.sessionIds, r.truncated))
              .catch(() => {});
          }, SEARCH_DEBOUNCE_MS);
        } else {
          actions.setContentHits('', []);
        }
      }
    },
    [actions, api],
  );
  const openFolder = useCallback((folder: string) => actions.openFolder(folder), [actions]);
  return { filter, set, openFolder, contentSearchReach };
}

/** Optimistic mutations: update the store first, POST in the background, revert
 *  the store on error. None await the network on the UI-update path. */
export function useSessionActions(): {
  newSession: (opts?: { instanceId?: string; harness?: string; model?: string; effort?: string }) => void;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  rename: (id: string, name: string) => void;
} {
  const { store, api } = useChatContext();
  const actions = useActions();

  // `model` / `effort` are pre-start settings: they ride on the pending pane and are
  // applied via POST /config right after the real session is lazily created on first
  // send (see useComposer) — matching bridge-ui, whose create call carries no model/effort.
  const newSession = useCallback(
    (opts?: { instanceId?: string; harness?: string; model?: string; effort?: string }) => {
      actions.openPending(opts);
    },
    [actions],
  );

  const archive = useCallback(
    (id: string) => {
      const prev = store.getState().sessions.get(id);
      if (!prev) return;
      actions.upsertSession({ ...prev, folderName: 'archive' });
      void api.archive(id).catch(() => {
        if (prev) actions.upsertSession(prev);
      });
    },
    [actions, api, store],
  );

  const unarchive = useCallback(
    (id: string) => {
      const prev = store.getState().sessions.get(id);
      if (!prev) return;
      actions.upsertSession({ ...prev, folderName: '' });
      void api.unarchive(id).catch(() => {
        if (prev) actions.upsertSession(prev);
      });
    },
    [actions, api, store],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const prev = store.getState().sessions.get(id);
      if (!prev) return;
      actions.upsertSession({ ...prev, displayName: name });
      void api.rename(id, name).catch(() => {
        if (prev) actions.upsertSession(prev);
      });
    },
    [actions, api, store],
  );

  return { newSession, archive, unarchive, rename };
}

/** Session detail info (system prompt, model, permission mode, tools, slash commands,
 *  sub-agents, skills, MCP servers). Lazily fetches `GET /sessions/{id}` on first use,
 *  caches the result in the store keyed by id (a cached `null` means the harness has
 *  reported no info yet — never re-fetched), and returns the cache thereafter. NEVER
 *  blocks the hot path: the fetch is fired in the background and the store update is
 *  what re-renders. `loading` is true only while the first fetch is in flight. */
export function useSessionInfo(sessionId: string | null): {
  info: SessionInfo | null;
  loading: boolean;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const info = useStore(store, (s) => (sessionId ? s.sessionInfo.get(sessionId) ?? null : null));
  const loading = useStore(store, (s) => (sessionId ? s.sessionInfoLoading.has(sessionId) : false));

  useEffect(() => {
    if (!sessionId) return;
    const state = store.getState();
    if (state.sessionInfo.has(sessionId)) return; // cached (incl. a fetched null)
    if (state.sessionInfoLoading.has(sessionId)) return;
    actions.setSessionInfoLoading(sessionId, true);
    void api
      .getSessionDetail(sessionId)
      .then((detail) => actions.setSessionInfo(sessionId, detail.info))
      .catch(() => actions.setSessionInfoLoading(sessionId, false));
  }, [sessionId, store, api, actions]);

  return { info, loading };
}

/** Full per-session detail (summary + info + `harnessConfig`) plus a permission-mode
 *  mutator — the source for the interactive permission-mode selector. LAZILY fetches
 *  `GET /sessions/{id}` on first use, caches the `ManagedSessionDetail` in the store
 *  keyed by id, and returns the cache thereafter. NEVER blocks the hot path: the fetch
 *  is backgrounded and the store update re-renders. `loading` is true only while the
 *  first fetch is in flight.
 *
 *  `setPermissionMode(mode)` OPTIMISTICALLY patches the cached detail's
 *  `harnessConfig.permissionMode`, then PUTs `/sessions/{id}/permission-mode`. On a
 *  non-2xx it REVERTS the cached detail to its prior value and rethrows — a failed
 *  change must be visible, never silently kept. Resolves once persisted. */
export function useManagedSession(sessionId: string | null): {
  session: ManagedSessionDetail | null;
  loading: boolean;
  setPermissionMode: (mode: string) => Promise<void>;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const session = useStore(store, (s) => (sessionId ? s.sessionDetail.get(sessionId) ?? null : null));
  const loading = useStore(store, (s) => (sessionId ? s.sessionDetailLoading.has(sessionId) : false));

  useEffect(() => {
    if (!sessionId) return;
    const state = store.getState();
    if (state.sessionDetail.has(sessionId)) return; // cached
    if (state.sessionDetailLoading.has(sessionId)) return;
    actions.setSessionDetailLoading(sessionId, true);
    void api
      .getSessionDetail(sessionId)
      .then((detail) => actions.setSessionDetail(sessionId, detail))
      .catch(() => actions.setSessionDetailLoading(sessionId, false));
  }, [sessionId, store, api, actions]);

  const setPermissionMode = useCallback(
    async (mode: string) => {
      if (!sessionId) return;
      await changeSessionPermissionMode({ store, api }, sessionId, mode);
    },
    [sessionId, store, api],
  );

  return { session, loading, setPermissionMode };
}

/** A session's rolled-up cost from its cached/active model's `TurnModel.aggregates`.
 *  Pure selector — NO network. Zeros for every field when aggregates are absent (the
 *  spend events fell outside the loaded page). */
export function useSessionCost(sessionId: string | null): SessionCost {
  const { store } = useChatContext();
  return useStore(store, (s) => sessionCost(s, sessionId));
}

/** A session's context-window usage from `TurnModel.aggregates`. Pure selector — NO
 *  network. `pct = tokens/limit*100`, or 0 when the limit is missing; zeros when
 *  aggregates are absent. */
export function useContextUsage(sessionId: string | null): ContextUsage {
  const { store } = useChatContext();
  return useStore(store, (s) => contextUsage(s, sessionId));
}

/** Ensure the harness registry (`GET /harnesses`) is loaded — fetched once, cached in the
 *  store, shared across every consumer. Never blocks the hot path. Internal to the
 *  capability/model hooks. */
function useEnsureHarnesses(): void {
  const { store, api } = useChatContext();
  const actions = useActions();
  useEffect(() => {
    const state = store.getState();
    if (state.harnesses !== null || state.harnessesLoading) return;
    actions.setHarnessesLoading(true);
    void api
      .getHarnesses()
      .then((list) => actions.setHarnesses(list))
      .catch(() => actions.setHarnessesLoading(false));
  }, [store, api, actions]);
}

/** Ensure the model registry (`GET /models`) is loaded — fetched once, cached, shared.
 *  Never blocks the hot path. Internal to `useModels`. */
function useEnsureModels(): void {
  const { store, api } = useChatContext();
  const actions = useActions();
  useEffect(() => {
    const state = store.getState();
    if (state.models !== null || state.modelsLoading) return;
    actions.setModelsLoading(true);
    void api
      .getModels()
      .then((list) => actions.setModels(list))
      .catch(() => actions.setModelsLoading(false));
  }, [store, api, actions]);
}

/** The capability set for a harness, from the CANONICAL `GET /harnesses` registry (never a
 *  hardcoded per-harness allowlist). The controls bar gates each control on this set:
 *  `capabilities.has('model' | 'effort' | 'compact' | 'fork' | 'system_prompt' | 'tools')`.
 *  Fetches the registry once on first use (cached in the store, shared); returns an empty
 *  set until it loads or when the harness is unknown — so a control simply stays hidden,
 *  never guessed. */
export function useHarnessCapabilities(harnessId: string | null): Set<string> {
  const { store } = useChatContext();
  useEnsureHarnesses();
  const harnesses = useStore(store, (s) => s.harnesses);
  return useMemo(() => harnessCapabilities(harnesses, harnessId), [harnesses, harnessId]);
}

/** The models for the controls-bar picker, from the CANONICAL `GET /models` registry
 *  (enabled rows only), filtered to a harness's `supportedProviders` exactly as bridge-ui's
 *  `harnessModels` does. Pass no `harnessId` (or a harness that declares no providers) to
 *  get every enabled model. Fetches the model + harness registries once on first use
 *  (cached, shared); returns `[]` until they load. Each option is
 *  `{ value: modelId, label, provider }`. */
export function useModels(harnessId?: string | null): ModelOption[] {
  const { store } = useChatContext();
  useEnsureModels();
  useEnsureHarnesses();
  const models = useStore(store, (s) => s.models);
  const harnesses = useStore(store, (s) => s.harnesses);
  return useMemo(
    () => modelsForHarness(models, harnesses, harnessId),
    [models, harnesses, harnessId],
  );
}

/** Live-session controls for the settings bar: `compact`, `fork`, `switchMode`, and the
 *  model/effort `setConfig`. All are LOUD — the underlying `ApiClient` methods throw on any
 *  non-2xx, and each control here surfaces the message on `error` and RETHROWS rather than
 *  faking a success/idle state.
 *
 *  `compacting` is set when `compact()` is invoked and cleared only when the CANONICAL
 *  `compact_boundary` system entry lands on the session's stream (or a 180s safety
 *  timeout) — the POST only ACKs, so this never fakes completion, mirroring bridge-ui.
 *  `forking` is true for the fork request's duration; on success it navigates the store to
 *  the new fork (whose summary arrives via the list SSE upsert). `error` is the last
 *  control error, or null. */
export function useSessionControls(sessionId: string | null): {
  compact: (summary?: string) => Promise<void>;
  fork: (displayName?: string) => Promise<void>;
  switchMode: (mode: 'events' | 'pty') => Promise<void>;
  setConfig: (config: SessionConfig) => Promise<void>;
  compacting: boolean;
  forking: boolean;
  error: string | null;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const [compacting, setCompacting] = useState(false);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = useStore(store, (s) => (sessionId ? turnsFor(s, sessionId) : undefined));
  // Max eventId at compact-request time — the boundary that clears `compacting` must be
  // newer than this, so a boundary already in history never resolves a fresh request.
  const compactStart = useRef<number>(-1);
  const compactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCompactTimer = useCallback(() => {
    if (compactTimer.current) {
      clearTimeout(compactTimer.current);
      compactTimer.current = null;
    }
  }, []);

  // Clear `compacting` when the canonical compact_boundary system entry arrives.
  useEffect(() => {
    if (!compacting || !model) return;
    for (const e of Object.values(model.entries)) {
      if (e.kind === 'system' && e.subtype === 'compact_boundary' && e.eventId > compactStart.current) {
        setCompacting(false);
        clearCompactTimer();
        return;
      }
    }
  }, [compacting, model, clearCompactTimer]);

  useEffect(() => () => clearCompactTimer(), [clearCompactTimer]);

  const compact = useCallback(
    async (summary?: string) => {
      if (!sessionId) return;
      setError(null);
      compactStart.current = store.getState().turnsBySession.get(sessionId)?.validator.maxEventId ?? -1;
      setCompacting(true);
      clearCompactTimer();
      // Safety net: a large context can take a while; the boundary event normally clears
      // this well before the timeout fires.
      compactTimer.current = setTimeout(() => {
        compactTimer.current = null;
        setCompacting(false);
      }, 180000);
      try {
        await api.compact(sessionId, summary);
      } catch (e) {
        clearCompactTimer();
        setCompacting(false);
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [api, store, sessionId, clearCompactTimer],
  );

  const fork = useCallback(
    async (displayName?: string) => {
      if (!sessionId) return;
      setError(null);
      setForking(true);
      try {
        const created = await api.fork(sessionId, displayName);
        // Navigate to the fork; its summary arrives via the global list SSE upsert.
        if (created.sessionId) {
          actions.setActive(created.sessionId);
          actions.clearPending();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setForking(false);
      }
    },
    [api, actions, sessionId],
  );

  const switchMode = useCallback(
    async (mode: 'events' | 'pty') => {
      if (!sessionId) return;
      setError(null);
      try {
        await api.switchMode(sessionId, mode);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [api, sessionId],
  );

  const setConfig = useCallback(
    async (config: SessionConfig) => {
      if (!sessionId) return;
      setError(null);
      try {
        await api.setConfig(sessionId, config);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [api, sessionId],
  );

  return { compact, fork, switchMode, setConfig, compacting, forking, error };
}

/**
 * The hooks this session has parked on a human decision, plus the verb that answers one.
 *
 * A permission ask freezes the tool call and produces NO other visible sign — no error,
 * no state the composer reads, nothing in the turn list. Without this surface the chat
 * simply stops, which is why the banner is not an optional affordance.
 *
 * Hydrates `GET /sessions/{id}/hooks/pending` on session change (the session SSE resumes
 * from Last-Event-ID, so a hook parked before the client attached is not replayed), then
 * lets the live stream keep the set current — `awaiting_resolution` inserts, `completed`
 * clears. A late response for a session the caller has already left is discarded.
 *
 * `resolve` clears the card optimistically and RESTORES it if the server refuses, then
 * rethrows so the caller can show why. The list identity is stable while nothing is
 * parked, so a session that never asks never re-renders the banner.
 */
export function usePendingPermissions(sessionId: string | null): {
  pending: PendingHook[];
  resolve: (input: HookResolveInput) => Promise<void>;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const hookMap = useStore(store, (s) =>
    sessionId ? s.pendingHooks.get(sessionId) ?? EMPTY_HOOKS : EMPTY_HOOKS,
  );

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    void api
      .getPendingHooks(sessionId)
      .then((hooks) => {
        if (live) actions.setPendingHooks(sessionId, hooks);
      })
      .catch(() => {
        // Non-fatal: the live stream still delivers anything parked from here on. The
        // banner just does not pre-populate for a hook parked before this client
        // attached.
      });
    return () => {
      live = false;
    };
  }, [sessionId, api, actions]);

  const pending = useMemo(() => [...hookMap.values()], [hookMap]);

  const resolve = useCallback(
    async (input: HookResolveInput) => {
      if (!sessionId) throw new Error('resolve hook: no active session');
      await resolvePendingHook({ store, api }, sessionId, input);
    },
    [sessionId, store, api],
  );

  return { pending, resolve };
}

/**
 * The session's spend halt, plus the one control that lifts it.
 *
 * llm-bridge-server stops a session that has spent its ceiling and then refuses every
 * send, resume and mode switch with a 402 until the ceiling moves. Neither half of
 * that produces anything else a client can see: the mid-turn interrupt is an error
 * event among many, and the 402 was, until this landed, swallowed whole by
 * `useComposer.send`. A halt with no visible cause reads as a hung session, which is
 * exactly the wrong conclusion — the session is fine and waiting on a number.
 *
 * `halt` is null for every session under its ceiling, every session without one, and
 * every server that predates the gate — none of those can produce the 402 or the
 * error code that sets it.
 *
 * `raiseCeiling` sets a new ceiling on the halted session and clears the halt. It
 * REPORTS the server's refusal text rather than throwing, and clears nothing when the
 * server refused: silence here would read as "raised" and the very next send would be
 * refused again. It works on a session whose process the gate already killed —
 * bridge-server persists the ceiling itself and only forwards to a harness when there
 * is one.
 */
export function useBudgetHalt(sessionId: string | null): {
  halt: BudgetHalt | null;
  raiseCeiling: (maxBudgetUSD: number) => Promise<string | null>;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const halt = useStore(store, (s) => (sessionId ? s.budgetHalts.get(sessionId) ?? null : null));

  const raiseCeiling = useCallback(
    async (maxBudgetUSD: number): Promise<string | null> => {
      if (!sessionId) return 'no active session';
      try {
        await api.setConfig(sessionId, { maxBudget: maxBudgetUSD });
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      actions.clearBudgetHalt(sessionId);
      return null;
    },
    [api, actions, sessionId],
  );

  return { halt, raiseCeiling };
}

/** Prefetch hint — call on sidebar row hover. Warms a cold session. */
export function usePrefetch(): (sessionId: string) => void {
  const { prefetcher } = useChatContext();
  return useCallback((sessionId: string) => prefetcher.prefetch(sessionId), [prefetcher]);
}

const PENDING_DRAFT_KEY = '__pending__';
const EMPTY_TURNS: Turn[] = [];
const EMPTY_ENTRIES: Record<string, Entry> = {};
