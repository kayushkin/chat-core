import { kindOf } from '../reduce/TurnReducer.js';
import { TERMINAL_ERROR_CODES, TERMINAL_EVENT_TYPES } from '../reduce/terminalState.js';
import type { Entry, TurnModel } from '../net/types.js';
import type { WireEvent } from '../net/wireEvents.js';
import { isRunningState } from './sessionStates.js';
import { resultedToolIds, toolIdOf } from './toolPairing.js';

// Per-turn ACTIVITY: what a running session is doing at this instant, as opposed to
// `SessionSummary.state`, which says what phase the server believes it is in.
//
// The two answer different questions and neither substitutes for the other. A state
// is a row the server writes and can strand (see reduce/terminalState.ts); an
// activity is read off the last event that actually arrived, so it is only ever as
// live as the stream feeding it. That is also its limit — chat-core opens a live
// stream for the ACTIVE session only (sync/SyncEngine.ts), so activity is knowable
// for that one session and for no other. Everything here is scoped accordingly.
//
// There are two ways to arrive at the same answer, and this module holds both.
// `activityFromEvent` folds the LIVE stream frame by frame. `activityFromModel`
// reads the SAME facts back off the materialized transcript, so selecting a session
// can fill its label in immediately instead of waiting for the next frame. They are
// two readings of one event log and must agree; each entry-shaped case below names
// the event-shaped case it mirrors.

/** What a session is doing right now.
 *
 *  Mirrors bridge-ui's `ActivityKind` (`bridge-ui/src/types.ts`) so the two surfaces
 *  describe a turn with the same four words. `streaming` means the model is emitting
 *  answer text; `thinking` means it is emitting reasoning; `tool` names the tool call
 *  in flight; `idle` means the turn is over or nothing has been heard. */
export type ActivityKind =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'streaming' }
  | { kind: 'tool'; name: string };

/** The one shared `idle` value. Handed back by `selectActivity` for every session
 *  with no entry, so a component that only ever sees idle sessions sees ONE
 *  reference and never re-renders on identity alone. */
export const IDLE_ACTIVITY: ActivityKind = { kind: 'idle' };

/** Whether two activity values say the same thing.
 *
 *  The tool name is part of what the label shows, so two `tool` activities naming
 *  different tools differ; every other kind carries no payload and is decided by the
 *  kind alone. Ported from bridge-ui's `sameActivity`, and it is load-bearing rather
 *  than cosmetic: a stream delta arrives per token, so without this guard every
 *  token would replace the activity map and re-render every subscriber in the app.
 *  chat-core's whole premise is that unchanged data keeps its reference. */
export function sameActivity(a: ActivityKind, b: ActivityKind): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tool' && b.kind === 'tool') return a.name === b.name;
  return true;
}

/**
 * The activity an event implies, or null when it implies nothing.
 *
 * Null is not `idle`. Most event types — hooks, `system`, `session_info`, a
 * `user_message` echo — say nothing at all about what the harness is doing, and
 * folding them in as `idle` would blank the label between two deltas of the same
 * answer. Only the events below move the value.
 *
 * The thinking-vs-text discrimination is `kindOf`'s (reduce/TurnReducer.ts), not a
 * second copy of it: `stream`, `block` and `thinking` all reach the same classifier
 * the reducer uses to build the row, so the label can never disagree with the
 * transcript it sits above.
 *
 * Turn ENDINGS are read wider than bridge-ui reads them. bridge-ui returns to idle
 * on `result` alone, so a turn that died — process killed, idle-timeout — leaves its
 * label pinned to the last tool it was running, forever. Every terminal signal
 * `terminalStateFromTail` already recognises is honoured here, from the same two
 * sets, plus a `session_state` that reports a state which is not a running one.
 */
export function activityFromEvent(event: WireEvent): ActivityKind | null {
  const type = event.type;

  // Turn endings first: `result` is both a terminal event type and a content event,
  // and it has to read as the end.
  if (TERMINAL_EVENT_TYPES.has(type)) return IDLE_ACTIVITY;
  if (type === 'error') {
    const code = event.data.error?.code;
    // api_error / api_retries_exhausted are informational — the harness retries and
    // keeps working, so they must not blank a live label.
    return code && TERMINAL_ERROR_CODES.has(code) ? IDLE_ACTIVITY : null;
  }
  if (type === 'session_state') {
    const state = event.data.state?.state;
    if (!state) return null;
    return isRunningState(state) ? null : IDLE_ACTIVITY;
  }

  switch (type) {
    case 'stream':
    case 'block':
    case 'thinking':
      return kindOf(event) === 'thinking' ? { kind: 'thinking' } : { kind: 'streaming' };
    case 'tool_call':
      // The name can be absent on a malformed event; an empty name still means a tool
      // is running, which is the fact worth showing.
      return { kind: 'tool', name: event.data.tool_call?.name ?? '' };
    case 'tool_result':
      // The tool answered and the model is composing again. Not idle — the turn is
      // still in flight.
      return { kind: 'streaming' };
    default:
      return null;
  }
}

/**
 * The activity ONE materialized entry implies, or null when it implies nothing.
 *
 * The entry-shaped twin of `activityFromEvent`, and deliberately a separate
 * function rather than a re-fold of `entry.raw`: `raw` is absent on the default
 * page (see net/types.ts — it was 78.9% of a measured page and is fetched only
 * when the Raw pane is open), so a transcript-derived label that read it would
 * work in one pane's presence and go blank in its absence.
 *
 * It reads the four promoted fields instead — `kind`, `role`, `toolName`, `code`
 * — plus `eventType` for the terminal event types that carry no `kind` of their
 * own, exactly as `terminalStateFromTail` does.
 *
 * ⚠️ A `session_state` entry says nothing here, where the event-shaped fold reads
 * it. The state it carries survives only on `raw`, so there is no honest way to
 * ask a materialized entry whether the state it announced was a running one.
 * That gap is why `activityFromModel` is gated on the session's own state at its
 * one call site rather than trusted alone.
 */
function activityFromEntry(entry: Entry, resultedTools: ReadonlySet<string>): ActivityKind | null {
  // `eventType` is the promoted field; `raw.type` is the fallback for a log-store
  // that predates it — the same pair, in the same order, as terminalStateFromTail.
  const eventType = entry.eventType ?? (entry.raw as { type?: string } | undefined)?.type;
  if (eventType && TERMINAL_EVENT_TYPES.has(eventType)) return IDLE_ACTIVITY;

  switch (entry.kind) {
    case 'result':
      return IDLE_ACTIVITY;
    case 'error':
      // Same split as the event fold: api_error / api_retries_exhausted are
      // informational and the harness keeps working past them.
      return entry.code && TERMINAL_ERROR_CODES.has(entry.code) ? IDLE_ACTIVITY : null;
    case 'thinking':
      return { kind: 'thinking' };
    case 'text':
      // An assistant bubble is the model emitting an answer. A USER bubble is the
      // prompt that opened the turn and says nothing about what the harness is
      // doing — `activityFromEvent` returns null for its `user_message` too.
      return entry.role === 'assistant' ? { kind: 'streaming' } : null;
    case 'tool_call': {
      // A call whose result has landed means the model is composing again — the
      // event fold reaches that through the separate `tool_result` frame, which the
      // transcript may not have as a row of its own. Both model shapes are asked,
      // exactly as `deriveStatus` asks them: the live reducer MERGES a result onto
      // its call, while the server-materialized page keeps the two as separate rows
      // paired only by tool id.
      //
      // `eventType` is read alongside `toolResult` because the merged entry records
      // the arrival in two places and only one of them always fires: `toolResult`
      // holds `raw.tool_result.output` (TurnReducer.ts), so a tool that answered with
      // NOTHING leaves it undefined, while `eventType` is the last folded frame's type
      // and says `tool_result` either way. A silent tool must not read as still
      // running.
      if (entry.toolResult !== undefined || entry.eventType === 'tool_result') {
        return { kind: 'streaming' };
      }
      const toolId = toolIdOf(entry);
      // A call that can never be paired is not pending, it is unknowable — the same
      // verdict `deriveStatus` reaches, and the reason this says nothing rather than
      // naming a tool that may have finished long ago.
      if (entry.unpairable || !toolId) return null;
      return resultedTools.has(toolId)
        ? { kind: 'streaming' }
        : { kind: 'tool', name: entry.toolName ?? '' };
    }
    case 'tool_result':
      // The tool answered and the model is composing again — still in flight.
      return { kind: 'streaming' };
    default:
      return null;
  }
}

/**
 * The activity a session's own TRANSCRIPT implies, or null when it implies nothing.
 *
 * This is what lets a label survive a session switch. The live fold
 * (`applyTailEvent`) can only speak for the session whose stream is attached, so
 * selecting a session used to leave the status line above the composer blank until
 * the next frame arrived — on a session running a long tool call, that is minutes
 * of a chat that looks idle while it works. Re-deriving from the transcript fills
 * the line in the same commit as the switch, and it cannot go stale the way a KEPT
 * label would: every value here comes from an entry that is on screen right now.
 *
 * Scanned BACKWARDS over the last turn's entries in display order, taking the first
 * that says anything — the newest statement wins, which is the same last-frame-wins
 * rule `applyTailEvents` folds live batches under. Ordering is by the model's own
 * entry list rather than by `eventId`, because the live and materialized paths
 * number their events in two different id spaces (see TailState.entryEventIds) and
 * a scan sorted on that field would interleave them wrongly.
 *
 * The LAST turn only, for `deriveStatus`'s reason: an aborted turn's unpaired tool
 * calls must not read as running for the rest of the session.
 *
 * Duplicate entries and a subagent's rows are skipped — the first are the OTel copy
 * of a row already counted, the second are another session's work sitting here
 * because the server had nowhere better to put it.
 */
export function activityFromModel(model: TurnModel | undefined): ActivityKind | null {
  const lastTurn = model?.turns[model.turns.length - 1];
  if (!model || !lastTurn) return null;
  const entries: Entry[] = [];
  for (const entryId of lastTurn.entryIds) {
    const entry = model.entries[entryId];
    if (entry && !entry.duplicate && !entry.harnessParentId) entries.push(entry);
  }
  const resultedTools = resultedToolIds(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const activity = activityFromEntry(entries[i]!, resultedTools);
    if (activity) return activity;
  }
  return null;
}
