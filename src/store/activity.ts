import { kindOf } from '../reduce/TurnReducer.js';
import { TERMINAL_ERROR_CODES, TERMINAL_EVENT_TYPES } from '../reduce/terminalState.js';
import type { WireEvent } from '../net/wireEvents.js';
import { isRunningState } from './sessionStates.js';

// Per-turn ACTIVITY: what a running session is doing at this instant, as opposed to
// `SessionSummary.state`, which says what phase the server believes it is in.
//
// The two answer different questions and neither substitutes for the other. A state
// is a row the server writes and can strand (see reduce/terminalState.ts); an
// activity is read off the last event that actually arrived, so it is only ever as
// live as the stream feeding it. That is also its limit — chat-core opens a live
// stream for the ACTIVE session only (sync/SyncEngine.ts), so activity is knowable
// for that one session and for no other. Everything here is scoped accordingly.

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
