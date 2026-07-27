import type { Entry, EntryKind, Role, Turn, TurnModel, Validator } from '../net/types.js';
import type { WireEvent, WireEventData } from '../net/wireEvents.js';
import { annotateOTelDuplicates } from './otelDedup.js';

// LIVE-TAIL reducer. Settled history is materialized once, server-side; this
// only folds the small stream of live SSE events onto an already-finished
// TurnModel. Every operation is O(1)-indexed by key (Map lookups, never
// findIndex), and every event is deduped by its log-store `event_id` so a
// Last-Event-ID replay is idempotent. It KEEPS every copy (both sources) and
// re-runs `annotateOTelDuplicates` so the dedup annotations stay correct as the
// late OTel copy arrives.

/** Reducer working state for one session's live tail. The wire `TurnModel` is
 *  kept in sync on `model`; `turnIndex` and `seenEventIds` are the O(1) indexes
 *  that keep application cheap and idempotent. */
export interface TailState {
  sessionId: string;
  model: TurnModel;
  /** turnId → index into `model.turns`, so turn lookup is O(1). */
  turnIndex: Map<string, number>;
  /** entry id → the log-store event ids that have been folded in, for dedup. */
  entryEventIds: Map<string, Set<number>>;
  /** every event id applied, so a replayed event is a no-op (idempotent). */
  seenEventIds: Set<number>;
}

const EMPTY_VALIDATOR: Validator = { maxEventId: 0, eventCount: 0, updatedAt: '' };

/** Build a fresh, empty tail state, or seed it from a server-materialized
 *  TurnModel (the warm/cold-switch path: reduce only the tail on top of this). */
export function initTailState(sessionId: string, model?: TurnModel): TailState {
  const base: TurnModel = model ?? {
    sessionId,
    turns: [],
    entries: {},
    validator: { ...EMPTY_VALIDATOR },
    more: false,
  };
  const turnIndex = new Map<string, number>();
  base.turns.forEach((t, i) => turnIndex.set(t.id, i));
  const entryEventIds = new Map<string, Set<number>>();
  const seenEventIds = new Set<number>();
  for (const id of Object.keys(base.entries)) {
    const e = base.entries[id];
    if (!e) continue;
    entryEventIds.set(id, new Set([e.eventId]));
    seenEventIds.add(e.eventId);
  }
  return { sessionId, model: base, turnIndex, entryEventIds, seenEventIds };
}

function eventIdOf(ev: WireEvent): number {
  if (typeof ev.data.event_id === 'number') return ev.data.event_id;
  if (ev.id) return Number(ev.id) || 0;
  return 0;
}

function sourceOf(data: WireEventData): 'harness' | 'otel' {
  return data.extensions?.source === 'otel' ? 'otel' : 'harness';
}

// The entry kind + role an event maps to. Mirrors bridge-ui's rowKindOf/actorFor,
// projected onto the chat-core Entry vocabulary.
function kindOf(ev: WireEvent): EntryKind {
  switch (ev.type) {
    case 'user_message':
      return 'text';
    case 'stream': {
      const dt = ev.data.stream?.delta?.type;
      if (dt === 'thinking_delta') return 'thinking';
      return 'text';
    }
    case 'block': {
      const bt = ev.data.block?.block?.type;
      if (bt === 'thinking') return 'thinking';
      return 'text';
    }
    case 'thinking':
      return 'thinking';
    case 'tool_call':
    case 'tool_result':
      return 'tool_call';
    case 'result':
      return 'result';
    case 'error':
      return 'error';
    case 'system':
      return 'system';
    case 'session_state':
    case 'session_info':
      return 'meta';
    default:
      return 'meta';
  }
}

function roleOf(ev: WireEvent, kind: EntryKind): Role {
  if (ev.type === 'user_message') return 'user';
  if (ev.type === 'tool_call' || ev.type === 'tool_result') return 'tool';
  if (ev.type === 'system' || ev.type === 'session_state' || ev.type === 'session_info') {
    return 'system';
  }
  void kind;
  return 'assistant';
}

// Grouping key: the stable Entry id. tool_call/tool_result pair by tool_id;
// user prompts and assistant content group by message_id + kind; anything
// without a message_id stands alone keyed by its event id.
function groupKeyFor(ev: WireEvent, kind: EntryKind): string {
  if (ev.type === 'tool_call' || ev.type === 'tool_result') {
    const toolId = ev.data.tool_call?.tool_id || ev.data.tool_result?.tool_id;
    if (toolId) return `tool_${toolId}`;
  }
  const msgId = ev.data.message_id;
  if (msgId) {
    if (ev.type === 'user_message') return `${msgId}_user`;
    return `${msgId}_${kind}`;
  }
  return `evt_${eventIdOf(ev)}`;
}

function turnKeyFor(ev: WireEvent, entryId: string): string {
  return ev.data.turn_id || `solo_${entryId}`;
}

// Fold an event's payload onto an entry (accumulating streamed text). Returns a
// new Entry; never mutates `prev`.
function applyPayload(prev: Entry, ev: WireEvent): Entry {
  const next: Entry = { ...prev, eventId: Math.max(prev.eventId, eventIdOf(ev)) };
  const raw = ev.data;
  switch (ev.type) {
    case 'user_message':
      next.text = raw.result?.text ?? prev.text ?? '';
      break;
    case 'stream': {
      const d = raw.stream?.delta;
      if (d?.type === 'text_delta') next.text = (prev.text || '') + (d.text || '');
      else if (d?.type === 'thinking_delta') next.text = (prev.text || '') + (d.thinking || '');
      break;
    }
    case 'block': {
      const b = raw.block?.block;
      if (b?.type === 'text' && b.text_block) next.text = (prev.text || '') + (b.text_block.text || '');
      else if (b?.type === 'thinking' && b.thinking_block) {
        next.text = (prev.text || '') + (b.thinking_block.text || '');
      }
      break;
    }
    case 'thinking':
      next.text = (prev.text || '') + (raw.thinking?.text || '');
      break;
    case 'tool_call':
      next.toolName = raw.tool_call?.name ?? prev.toolName;
      next.toolInput = raw.tool_call?.input ?? prev.toolInput;
      break;
    case 'tool_result':
      next.toolName = raw.tool_result?.name ?? prev.toolName;
      next.toolResult = raw.tool_result?.output ?? prev.toolResult;
      break;
    case 'result':
      next.text = raw.result?.text || prev.text;
      break;
    case 'error':
      next.text = raw.error?.message || prev.text || 'error';
      // Carry the canonical ErrorEvent fields so the edge can style the chip and
      // the terminal-state reconcile can spot TURN_IDLE_TIMEOUT / PROCESS_DIED.
      if (raw.error?.code !== undefined) next.code = raw.error.code;
      if (raw.error?.retryable !== undefined) next.retryable = raw.error.retryable;
      if (raw.error?.status_code !== undefined) next.statusCode = raw.error.status_code;
      break;
    case 'system':
      next.text = raw.system?.message ?? prev.text;
      if (raw.system?.subtype !== undefined) next.subtype = raw.system.subtype;
      break;
    default:
      break;
  }
  // Recovered-assistant provenance rides on extensions (block events); never gates
  // visibility — it's a presentation marker only.
  if (raw.extensions?.recovered === true) next.recovered = true;
  next.raw = raw;
  return next;
}

/**
 * Apply one live event to a tail state, returning a NEW state (pure; the input
 * is never mutated). O(1): entry + turn lookups are Map/record indexed, and a
 * repeated `event_id` is a no-op — so replaying from Last-Event-ID converges.
 * Re-runs the OTel annotator so the collapsed/raw views stay correct.
 */
export function applyEvent(state: TailState, ev: WireEvent): TailState {
  const evId = eventIdOf(ev);
  if (evId && state.seenEventIds.has(evId)) {
    return state; // idempotent — already folded in.
  }

  const kind = kindOf(ev);
  const role = roleOf(ev, kind);
  const entryId = groupKeyFor(ev, kind);
  const ts = ev.data.timestamp || new Date().toISOString();

  const entries: Record<string, Entry> = { ...state.model.entries };
  const turnIndex = new Map(state.turnIndex);
  const entryEventIds = new Map(state.entryEventIds);
  const seenEventIds = new Set(state.seenEventIds);
  let turns = state.model.turns;

  const existing = entries[entryId];
  let entry: Entry;
  if (existing) {
    entry = applyPayload(existing, ev);
  } else {
    const fresh: Entry = {
      id: entryId,
      turnId: turnKeyFor(ev, entryId),
      role,
      kind,
      source: sourceOf(ev.data),
      eventId: evId,
      ts,
      duplicate: false,
      primary: true,
    };
    entry = applyPayload(fresh, ev);
  }
  entries[entryId] = entry;

  // Track contributing event ids for this entry + globally, for dedup.
  const ids = new Set(entryEventIds.get(entryId) ?? []);
  if (evId) ids.add(evId);
  entryEventIds.set(entryId, ids);
  if (evId) seenEventIds.add(evId);

  // Attach the entry to its turn (creating the turn if new).
  const turnId = entry.turnId;
  const tIdx = turnIndex.get(turnId);
  if (tIdx === undefined) {
    const turn: Turn = { id: turnId, role: entry.role, ts, entryIds: [entryId] };
    turns = [...turns, turn];
    turnIndex.set(turnId, turns.length - 1);
  } else if (!existing) {
    const turn = turns[tIdx];
    if (turn && !turn.entryIds.includes(entryId)) {
      const nextTurn: Turn = {
        ...turn,
        entryIds: [...turn.entryIds, entryId].sort(
          (a, b) => (entries[a]?.eventId ?? 0) - (entries[b]?.eventId ?? 0),
        ),
      };
      turns = turns.slice();
      turns[tIdx] = nextTurn;
    }
  }

  // Re-annotate OTel duplicates across the (small) live tail. Non-destructive:
  // it only tags duplicate/primary/groupId, so nothing is dropped.
  const annotated = annotateOTelDuplicates(Object.values(entries));
  const annotatedEntries: Record<string, Entry> = {};
  for (const e of annotated) annotatedEntries[e.id] = e;

  const maxEventId = Math.max(state.model.validator.maxEventId, evId);
  const model: TurnModel = {
    sessionId: state.model.sessionId || state.sessionId,
    turns,
    entries: annotatedEntries,
    validator: {
      maxEventId,
      eventCount: seenEventIds.size,
      updatedAt: ts,
    },
    more: state.model.more,
  };

  return { sessionId: state.sessionId, model, turnIndex, entryEventIds, seenEventIds };
}

/** Convenience: fold a batch of events (e.g. a history replay) in order. */
export function applyEvents(state: TailState, events: WireEvent[]): TailState {
  let s = state;
  for (const ev of events) s = applyEvent(s, ev);
  return s;
}
