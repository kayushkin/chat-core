import { useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import type { Entry, SessionSummary, Turn } from '../net/types.js';
import type { ChatActions, FilterState } from '../store/ChatStore.js';
import {
  activeSummaryEffective,
  effectiveState,
  sourcesForEntry,
  turnsFor,
  visibleCount,
  visibleSessions,
  visibleEntryIdsFor,
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
} {
  const { store } = useChatContext();
  const groups = useStore(store, visibleSessions);
  const total = useStore(store, visibleCount);
  const loading = useStore(store, (s) => s.listLoading);
  const turnsBySession = useStore(store, (s) => s.turnsBySession);
  const sessions = useStore(store, (s) => s.sessions);
  const effState = useCallback(
    (sessionId: string) => effectiveState(store.getState(), sessionId),
    [store, turnsBySession, sessions],
  );
  return { groups, total, loading, effectiveState: effState };
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

/** Composer for a session (or the pending/new pane). */
export function useComposer(sessionId: string | null): {
  send: (text: string) => void;
  draft: string;
  setDraft: (t: string) => void;
  sending: boolean;
} {
  const { store, api } = useChatContext();
  const actions = useActions();
  const key = sessionId ?? PENDING_DRAFT_KEY;
  const draft = useStore(store, (s) => s.drafts.get(key) ?? '');
  const sending = useStore(store, (s) => (sessionId ? s.sending.has(sessionId) : false));

  const setDraft = useCallback((t: string) => actions.setDraft(key, t), [actions, key]);

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

  return { send, draft, setDraft, sending };
}

/** Filters + folders (client-side; switching is sub-10ms). */
export function useFilters(): {
  filter: FilterState;
  set: (patch: Partial<FilterState>) => void;
  openFolder: (folder: string) => void;
} {
  const { store } = useChatContext();
  const filter = useStore(store, (s) => s.filter);
  const actions = useActions();
  const set = useCallback((patch: Partial<FilterState>) => actions.setFilter(patch), [actions]);
  const openFolder = useCallback((folder: string) => actions.openFolder(folder), [actions]);
  return { filter, set, openFolder };
}

/** Optimistic mutations: update the store first, POST in the background, revert
 *  the store on error. None await the network on the UI-update path. */
export function useSessionActions(): {
  newSession: (opts?: { instanceId?: string; harness?: string }) => void;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  rename: (id: string, name: string) => void;
} {
  const { store, api } = useChatContext();
  const actions = useActions();

  const newSession = useCallback(
    (opts?: { instanceId?: string; harness?: string }) => {
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

/** Prefetch hint — call on sidebar row hover. Warms a cold session. */
export function usePrefetch(): (sessionId: string) => void {
  const { prefetcher } = useChatContext();
  return useCallback((sessionId: string) => prefetcher.prefetch(sessionId), [prefetcher]);
}

const PENDING_DRAFT_KEY = '__pending__';
const EMPTY_TURNS: Turn[] = [];
const EMPTY_ENTRIES: Record<string, Entry> = {};
