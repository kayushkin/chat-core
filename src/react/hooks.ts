import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type {
  Entry,
  ManagedSessionDetail,
  ModelOption,
  SessionConfig,
  SessionInfo,
  SessionSummary,
  Turn,
} from '../net/types.js';
import type { ChatActions, FilterState } from '../store/ChatStore.js';
import { changeSessionPermissionMode } from '../store/permissionMode.js';
import {
  activeSummaryEffective,
  contextUsage,
  effectiveState,
  harnessCapabilities,
  modelsForHarness,
  selectFacets,
  sessionCost,
  sourcesForEntry,
  turnsFor,
  visibleCount,
  visibleSessions,
  visibleEntryIdsFor,
  type ContextUsage,
  type Facets,
  type SessionCost,
} from '../store/selectors.js';
import { useChatContext } from './context.js';

// All hooks read via Zustand selector subscriptions so only components whose
// slice changed re-render. select() / filter changes / newSession / archive
// NEVER await the network on the path that updates the UI — a fetch, if needed,
// is fired in the background.

function useActions(): ChatActions {
  const { store } = useChatContext();
  return useStore(store, (s) => s.actions);
}

/** Sidebar list, already filtered + grouped + sorted by the current filter/folder.
 *  `effectiveState(sessionId)` returns the tail-reconciled state for a row's status
 *  indicator: a session the server still reports as running/holding but whose warm
 *  tail is terminal reads as completed/failed, so a stale spinner self-heals on open
 *  (F1). The function's identity changes when the tails or session maps change, so a
 *  settling tail re-renders the affected rows. */
export function useSessionList(): {
  groups: { folder: string; sessions: SessionSummary[] }[];
  total: number;
  loading: boolean;
  effectiveState: (sessionId: string) => string;
  facets: Facets;
} {
  const { store } = useChatContext();
  const groups = useStore(store, visibleSessions);
  const total = useStore(store, visibleCount);
  const loading = useStore(store, (s) => s.listLoading);
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
  return { groups, total, loading, effectiveState: effState, facets };
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

/** Composer + turn controls for a session (or the pending/new pane).
 *
 *  `stop()` interrupts the running turn (POST /sessions/{id}/interrupt). It is a
 *  LOUD control: `ApiClient.interrupt` throws on any non-2xx (e.g. the 409 the
 *  server returns while a tool still holds the turn), and `stop()` sets `error` AND
 *  rethrows rather than optimistically marking the session idle — a failed stop must
 *  be visible, never swallowed into a fake-idle. `interrupting` is true for the
 *  duration of the request; `paused` reflects a parked/held session state (checked
 *  as the explicit 'paused' value, never a bare `state === 'running'` — `tool_running`
 *  is also busy, the §5 enum trap). */
export function useComposer(sessionId: string | null): {
  send: (text: string) => void;
  draft: string;
  setDraft: (t: string) => void;
  sending: boolean;
  stop: () => Promise<void>;
  interrupting: boolean;
  paused: boolean;
  error: string | null;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const key = sessionId ?? PENDING_DRAFT_KEY;
  const draft = useStore(store, (s) => s.drafts.get(key) ?? '');
  const sending = useStore(store, (s) => (sessionId ? s.sending.has(sessionId) : false));
  const state = useStore(store, (s) => (sessionId ? s.sessions.get(sessionId)?.state : undefined));
  const paused = state === 'paused';
  const [interrupting, setInterrupting] = useState(false);
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

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      actions.setDraft(key, '');

      // Lazy-create a real session for the pending pane on first send.
      if (!sessionId) {
        const pending = store.getState().pending;
        void api
          .createSession(pending ? { instanceId: pending.instanceId, harness: pending.harness } : undefined)
          .then((created) => {
            const newId = created.sessionId;
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
            actions.appendOptimisticUser(newId, trimmed, `c_${Date.now()}`);
            actions.setSending(newId, true);
            return api.send(newId, trimmed).finally(() => actions.setSending(newId, false));
          })
          .catch(() => {});
        return;
      }

      // Optimistic: show the user's text instantly, then POST + reconcile.
      const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      actions.appendOptimisticUser(sessionId, trimmed, clientId);
      actions.setSending(sessionId, true);
      void api
        .send(sessionId, trimmed)
        .finally(() => actions.setSending(sessionId, false));
    },
    [actions, api, store, sessionId, key],
  );

  return { send, draft, setDraft, sending, stop, interrupting, paused, error };
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
} {
  const { store, api } = useChatContext();
  const filter = useStore(store, (s) => s.filter);
  const actions = useActions();
  const set = useCallback(
    (patch: Partial<FilterState>) => {
      actions.setFilter(patch); // instant/local — never awaits the network.
      if (patch.search !== undefined) {
        const q = patch.search.trim();
        if (q) {
          // Async augmentation; setContentHits ignores a stale response.
          void api
            .search(q)
            .then((r) => actions.setContentHits(q, r.sessionIds))
            .catch(() => {});
        } else {
          actions.setContentHits('', []);
        }
      }
    },
    [actions, api],
  );
  const openFolder = useCallback((folder: string) => actions.openFolder(folder), [actions]);
  return { filter, set, openFolder };
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

/** Prefetch hint — call on sidebar row hover. Warms a cold session. */
export function usePrefetch(): (sessionId: string) => void {
  const { prefetcher } = useChatContext();
  return useCallback((sessionId: string) => prefetcher.prefetch(sessionId), [prefetcher]);
}

const PENDING_DRAFT_KEY = '__pending__';
const EMPTY_TURNS: Turn[] = [];
const EMPTY_ENTRIES: Record<string, Entry> = {};
