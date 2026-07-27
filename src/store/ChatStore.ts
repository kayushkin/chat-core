import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Entry, SessionSummary, Turn, TurnModel } from '../net/types.js';
import type { WireEvent } from '../net/wireEvents.js';
import { applyEvent, initTailState, type TailState } from '../reduce/TurnReducer.js';

// L1 hot store (decision D2). Zustand vanilla store held in `Map`s for the
// working set. ACTIONS ARE THE ONLY MUTATION PATH — both the SyncEngine and the
// UI go through them, so the optimistic and reconciled paths converge on one
// model. Selector subscriptions (see react/hooks.ts) mean only components whose
// slice changed re-render.

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed';

export interface FilterState {
  harness: string | null;
  status: string | null;
  type: string | null;
  purpose: string | null;
  mode: string | null;
  folder: string | null;
  search: string;
}

export const EMPTY_FILTER: FilterState = {
  harness: null,
  status: null,
  type: null,
  purpose: null,
  mode: null,
  folder: null,
  search: '',
};

/** A pending (not-yet-created) session pane — 0 network until first send. */
export interface PendingSession {
  clientId: string;
  instanceId?: string;
  harness?: string;
}

/** Content-search augmentation (C6). The set of session ids whose materialized
 *  transcript text matched `query`, fetched async via `ApiClient.search`. `query`
 *  pins the hits to the filter they were fetched for, so a stale set is never
 *  folded into a newer search. The instant local name match never waits on this. */
export interface ContentHits {
  query: string;
  ids: Set<string>;
}

export interface ChatState {
  sessions: Map<string, SessionSummary>;
  turnsBySession: Map<string, TurnModel>;
  /** Internal live-tail reducer state per session (not for direct UI reads). */
  tails: Map<string, TailState>;
  activeId: string | null;
  filter: FilterState;
  /** Content-search hits for the current `filter.search`, or null when none have
   *  been fetched (or the query changed and the prior set was invalidated). */
  contentHits: ContentHits | null;
  /** Known folder names, maintained from session upserts. */
  folders: string[];
  connState: ConnState;
  listLoading: boolean;
  turnsLoading: Set<string>;
  moreBySession: Map<string, boolean>;
  drafts: Map<string, string>;
  sending: Set<string>;
  pending: PendingSession | null;

  actions: ChatActions;
}

export interface ChatActions {
  setConn(state: ConnState): void;
  setListLoading(loading: boolean): void;

  setSessions(list: SessionSummary[]): void;
  upsertSession(summary: SessionSummary): void;
  removeSession(sessionId: string): void;

  setActive(sessionId: string | null): void;

  setTurns(sessionId: string, model: TurnModel): void;
  applyTailEvent(sessionId: string, event: WireEvent): void;
  setTurnsLoading(sessionId: string, loading: boolean): void;
  prependOlder(sessionId: string, older: TurnModel): void;

  appendOptimisticUser(sessionId: string, text: string, clientId: string): void;

  setFilter(patch: Partial<FilterState>): void;
  openFolder(folder: string): void;
  /** Record async content-search hits for a query. Ignored (a no-op) if the
   *  current filter's search no longer equals `query`, so a late/stale response
   *  can't override a newer search. */
  setContentHits(query: string, ids: string[]): void;

  setDraft(sessionId: string, text: string): void;
  setSending(sessionId: string, sending: boolean): void;

  openPending(opts?: { instanceId?: string; harness?: string }): PendingSession;
  clearPending(): void;
}

export type ChatStoreApi = StoreApi<ChatState>;

function collectFolders(sessions: Iterable<SessionSummary>): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    if (s.folderName) set.add(s.folderName);
  }
  return [...set].sort();
}

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

      setSessions(list) {
        const sessions = new Map<string, SessionSummary>();
        for (const s of list) sessions.set(s.sessionId, s);
        set({ sessions, folders: collectFolders(sessions.values()), listLoading: false });
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
        set({
          sessions,
          turnsBySession,
          tails,
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
          if (!cur || cur.query !== filter.search) nextState.contentHits = null;
        }
        set(nextState);
      },

      openFolder(folder) {
        set({ filter: { ...get().filter, folder } });
      },

      setContentHits(query, ids) {
        // Drop a stale response whose query no longer matches the live filter.
        if (get().filter.search !== query) return;
        set({ contentHits: { query, ids: new Set(ids) } });
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
        };
        set({ pending, activeId: null });
        return pending;
      },

      clearPending() {
        set({ pending: null });
      },
    };

    return {
      sessions: new Map(),
      turnsBySession: new Map(),
      tails: new Map(),
      activeId: null,
      filter: { ...EMPTY_FILTER },
      contentHits: null,
      folders: [],
      connState: 'idle',
      listLoading: false,
      turnsLoading: new Set(),
      moreBySession: new Map(),
      drafts: new Map(),
      sending: new Set(),
      pending: null,
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
