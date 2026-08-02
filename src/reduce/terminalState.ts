import type { TurnModel } from '../net/types.js';

// Client-side terminal-state reconcile (the F1 fix). A session's SessionSummary.state
// can stay pinned to a holding value (tool_running) forever when the server's state
// derivation misses the settling transition or the harness process hung — that is a
// live server defect (see dash/docs/dashv2-architecture.md F1). The materialized tail
// is authoritative: if it already contains a terminal signal, the displayed state is
// stale and must be corrected from the tail rather than trusting the summary row.
//
// This is a PURE scan over an already-materialized TurnModel. It never mutates and
// never fetches; the effectiveState selector composes it with the summary state.

/** Error codes that terminate a turn (per the OTel consumer contract). Distinct from
 *  api_error / api_retries_exhausted, which are INFORMATIONAL chips and must NOT clear
 *  the running state. */
export const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'TURN_IDLE_TIMEOUT',
  'PROCESS_DIED',
]);

/** Raw event types that terminate a turn: the normal completion signals. */
export const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn_complete',
  'close',
  'result',
]);

/**
 * Scan a materialized tail for a terminal signal and report the state it implies:
 *  - an Entry of kind 'result'                               → 'completed'
 *  - kind 'error' with code TURN_IDLE_TIMEOUT / PROCESS_DIED → 'failed'
 *  - a raw event type turn_complete / close / result         → 'completed'
 * Returns null when the tail carries no terminal signal (the turn is genuinely in
 * flight). When several terminal signals are present, the one with the highest
 * eventId wins, so a later result supersedes an earlier informational error.
 */
export function terminalStateFromTail(
  model: TurnModel | undefined,
): 'completed' | 'failed' | null {
  if (!model) return null;
  let best: { eventId: number; state: 'completed' | 'failed' } | null = null;
  for (const e of Object.values(model.entries)) {
    let state: 'completed' | 'failed' | null = null;
    if (e.kind === 'result') {
      state = 'completed';
    } else if (e.kind === 'error' && e.code && TERMINAL_ERROR_CODES.has(e.code)) {
      state = 'failed';
    } else {
      const rawType = (e.raw as { type?: string } | undefined)?.type;
      if (rawType && TERMINAL_EVENT_TYPES.has(rawType)) state = 'completed';
    }
    if (state && (!best || e.eventId >= best.eventId)) {
      best = { eventId: e.eventId, state };
    }
  }
  return best ? best.state : null;
}
