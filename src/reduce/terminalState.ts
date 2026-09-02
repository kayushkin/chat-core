import type { TurnModel } from '../net/types.js';

// Client-side terminal-state reconcile (the F1 fix). A session's SessionSummary.state
// can stay pinned to a holding value (tool_running) forever when the server's state
// derivation misses the settling transition or the harness process hung — that is a
// live server defect (see dash/docs/chat-architecture.md F1). The materialized tail
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
 *  - kind 'error' with code TURN_IDLE_TIMEOUT / PROCESS_DIED → 'error'
 *  - a raw event type turn_complete / close / result         → 'completed'
 * Returns null when the tail carries no terminal signal (the turn is genuinely in
 * flight). When several terminal signals are present, the one with the highest
 * eventId wins, so a later result supersedes an earlier informational error.
 *
 * ⚠️ The failure spelling is 'error', not 'failed', because this value is rendered
 * as a session state: it flows through effectiveState into bridge-ui's StatusDot,
 * which turns it straight into the class `bc-status-dot-${state}`. The canonical
 * vocabulary is llm-bridge's msg.SessionState, which spells the terminal failure
 * "error" (SessionError) and has no "failed" member; bridge-ui's SessionUIState
 * mirrors it. This returned 'failed' until 2026-08-14, and because no
 * `.bc-status-dot-failed` rule exists over a `background: transparent` base, every
 * failed session rendered an INVISIBLE dot — the reconcile fired and showed
 * nothing. Do not "fix" a future mismatch here by adding a CSS rule for a spelling
 * this enum does not have; correct the spelling.
 *
 * ⚠️ Not to be confused with msg.TaskStatus, a DIFFERENT canonical vocabulary that
 * genuinely does spell its terminal failure "failed" (see TERMINAL_TASK_STATUSES in
 * store/selectors.ts). One word, two enums — check which one you are in.
 */
export function terminalStateFromTail(
  model: TurnModel | undefined,
): 'completed' | 'error' | null {
  if (!model) return null;
  let best: { eventId: number; state: 'completed' | 'error' } | null = null;
  for (const e of Object.values(model.entries)) {
    let state: 'completed' | 'error' | null = null;
    if (e.kind === 'result') {
      state = 'completed';
    } else if (e.kind === 'error' && e.code && TERMINAL_ERROR_CODES.has(e.code)) {
      state = 'error';
    } else {
      // `eventType` is the promoted field; `raw.type` is the fallback for a
      // log-store that predates it. See toolPairing.ts for when that goes.
      const eventType = e.eventType ?? (e.raw as { type?: string } | undefined)?.type;
      if (eventType && TERMINAL_EVENT_TYPES.has(eventType)) state = 'completed';
    }
    if (state && (!best || e.eventId >= best.eventId)) {
      best = { eventId: e.eventId, state };
    }
  }
  return best ? best.state : null;
}
