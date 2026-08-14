import { describe, expect, it } from 'vitest';
import {
  TERMINAL_ERROR_CODES,
  TERMINAL_EVENT_TYPES,
  terminalStateFromTail,
} from '../src/reduce/terminalState.js';
import { effectiveState } from '../src/store/selectors.js';
import { createChatStore } from '../src/store/ChatStore.js';
import type { Entry, TurnModel } from '../src/net/types.js';
import type { SessionSummary } from '../src/net/types.js';

function entry(over: Partial<Entry> & Pick<Entry, 'id' | 'kind' | 'eventId'>): Entry {
  return {
    turnId: 't',
    role: 'assistant',
    source: 'harness',
    ts: '2026-07-27T14:00:00-07:00',
    duplicate: false,
    primary: true,
    ...over,
  };
}

function model(entries: Entry[]): TurnModel {
  const map: Record<string, Entry> = {};
  for (const e of entries) map[e.id] = e;
  return {
    sessionId: 's',
    turns: [],
    entries: map,
    validator: { maxEventId: 0, eventCount: entries.length, updatedAt: '' },
    more: false,
  };
}

function summary(over: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    state: 'idle',
    harness: 'claudecode',
    instanceId: 'i',
    type: 'interactive',
    purpose: 'chat',
    mode: 'events',
    folderName: '',
    displayName: over.sessionId,
    agentId: '',
    updatedAt: '2026-07-27T10:00:00-07:00',
    createdAt: '2026-07-27T10:00:00-07:00',
    ...over,
  };
}

function seed(sm: SessionSummary, m?: TurnModel) {
  const store = createChatStore();
  store.getState().actions.setSessions([sm]);
  if (m) store.getState().actions.setTurns(sm.sessionId, m);
  return store;
}

describe('terminalStateFromTail', () => {
  it('returns null for an in-flight tail (no terminal signal)', () => {
    const m = model([
      entry({ id: 'a', kind: 'text', eventId: 1, text: 'streaming…' }),
      entry({ id: 'b', kind: 'tool_call', eventId: 2, toolName: 'Bash' }),
    ]);
    expect(terminalStateFromTail(m)).toBeNull();
  });

  it('detects a normal result → completed', () => {
    const m = model([entry({ id: 'r', kind: 'result', eventId: 5, text: 'done' })]);
    expect(terminalStateFromTail(m)).toBe('completed');
  });

  it('detects TURN_IDLE_TIMEOUT → error', () => {
    const m = model([entry({ id: 'e', kind: 'error', eventId: 5, code: 'TURN_IDLE_TIMEOUT' })]);
    expect(terminalStateFromTail(m)).toBe('error');
  });

  it('detects PROCESS_DIED → error', () => {
    const m = model([entry({ id: 'e', kind: 'error', eventId: 5, code: 'PROCESS_DIED' })]);
    expect(terminalStateFromTail(m)).toBe('error');
  });

  it('detects a raw turn_complete event type → completed', () => {
    const m = model([entry({ id: 'tc', kind: 'meta', eventId: 5, raw: { type: 'turn_complete' } })]);
    expect(terminalStateFromTail(m)).toBe('completed');
  });

  it('detects a raw close event type → completed', () => {
    const m = model([entry({ id: 'c', kind: 'meta', eventId: 5, raw: { type: 'close' } })]);
    expect(terminalStateFromTail(m)).toBe('completed');
  });

  it('does NOT treat an informational api_error as terminal', () => {
    const m = model([
      entry({ id: 'ai', kind: 'error', eventId: 5, code: 'api_error', retryable: true, statusCode: 529 }),
    ]);
    expect(terminalStateFromTail(m)).toBeNull();
  });

  it('lets the highest-eventId terminal signal win (a later result supersedes an earlier error)', () => {
    const m = model([
      entry({ id: 'e', kind: 'error', eventId: 5, code: 'TURN_IDLE_TIMEOUT' }),
      entry({ id: 'r', kind: 'result', eventId: 9, text: 'ok' }),
    ]);
    expect(terminalStateFromTail(m)).toBe('completed');
  });
});

describe('effectiveState — client terminal-state reconcile (F1)', () => {
  it("overrides a stale 'tool_running' summary when the tail is terminal", () => {
    const store = seed(
      summary({ sessionId: 's1', state: 'tool_running' }),
      model([entry({ id: 'r', kind: 'result', eventId: 5, text: 'done' })]),
    );
    expect(effectiveState(store.getState(), 's1')).toBe('completed');
  });

  it("maps a terminating TURN_IDLE_TIMEOUT to 'error'", () => {
    const store = seed(
      summary({ sessionId: 's1', state: 'tool_running' }),
      model([entry({ id: 'e', kind: 'error', eventId: 5, code: 'TURN_IDLE_TIMEOUT' })]),
    );
    expect(effectiveState(store.getState(), 's1')).toBe('error');
  });

  it('leaves a genuinely-running session alone (tail not terminal)', () => {
    const store = seed(
      summary({ sessionId: 's1', state: 'tool_running' }),
      model([entry({ id: 'a', kind: 'text', eventId: 5, text: 'thinking…' })]),
    );
    expect(effectiveState(store.getState(), 's1')).toBe('tool_running');
  });

  it('leaves a parked (awaiting_user) session alone even with a terminal tail', () => {
    const store = seed(
      summary({ sessionId: 's1', state: 'awaiting_user' }),
      model([entry({ id: 'r', kind: 'result', eventId: 5, text: 'done' })]),
    );
    expect(effectiveState(store.getState(), 's1')).toBe('awaiting_user');
  });

  it('returns the raw state when no warm tail exists', () => {
    const store = seed(summary({ sessionId: 's1', state: 'tool_running' }));
    expect(effectiveState(store.getState(), 's1')).toBe('tool_running');
  });
});

/**
 * The vocabulary guard.
 *
 * `effectiveState`'s return value is not an internal token: dash writes it straight
 * into bridge-ui's `<StatusDot state={...} />`, which renders it as the class
 * `bc-status-dot-${state}`. A spelling outside the canonical vocabulary therefore
 * does not throw, does not fail a typecheck (`StatusDotState` is
 * `SessionUIState | (string & {})`, deliberately open) and does not log — it selects
 * a CSS rule that does not exist, and the dot renders invisible over the base
 * `background: transparent`.
 *
 * That is exactly what shipped: this module returned 'failed', a spelling in neither
 * llm-bridge's `msg.SessionState` (which spells it "error") nor bridge-ui's
 * `SessionUIState`. Every failed session showed nothing at all.
 *
 * ⚠️ These cases are driven off the module's own exported code/type SETS rather than
 * a hand-written list of inputs, so a terminal signal added later cannot join the
 * vocabulary without someone choosing its spelling here. A hand-listed set of inputs
 * is a claim about the producers that nobody re-reads.
 */
describe('the terminal vocabulary is the canonical SessionState spelling', () => {
  // From llm-bridge msg/provider.go (SessionCompleted, SessionError) — the enum dash
  // and bridge-ui both mirror. NOT msg.TaskStatus, a different vocabulary that does
  // spell its terminal failure "failed".
  const CANONICAL_TERMINAL_STATES = ['completed', 'error'];

  it('never emits a spelling outside the canonical vocabulary, for ANY terminal signal it recognises', () => {
    const seen = new Set<string>();

    for (const code of TERMINAL_ERROR_CODES) {
      const got = terminalStateFromTail(model([entry({ id: 'e', kind: 'error', eventId: 5, code })]));
      expect(CANONICAL_TERMINAL_STATES, `error code ${code} produced an uncanonical state`).toContain(got);
      seen.add(got!);
    }

    for (const type of TERMINAL_EVENT_TYPES) {
      const got = terminalStateFromTail(model([entry({ id: 'm', kind: 'meta', eventId: 5, raw: { type } })]));
      expect(CANONICAL_TERMINAL_STATES, `raw event type ${type} produced an uncanonical state`).toContain(got);
      seen.add(got!);
    }

    const fromResult = terminalStateFromTail(model([entry({ id: 'r', kind: 'result', eventId: 5, text: 'done' })]));
    expect(CANONICAL_TERMINAL_STATES).toContain(fromResult);
    seen.add(fromResult!);

    // Both halves are actually exercised — otherwise this passes by only ever
    // reaching the 'completed' branch, which was never the broken one.
    expect([...seen].sort()).toEqual(['completed', 'error']);
  });

  it("reconciles a stale spinner to 'error', the spelling bridge-ui has a rule for", () => {
    const store = seed(
      summary({ sessionId: 's1', state: 'tool_running' }),
      model([entry({ id: 'e', kind: 'error', eventId: 5, code: 'PROCESS_DIED' })]),
    );
    const got = effectiveState(store.getState(), 's1');
    expect(got).toBe('error');
    // The regression this pins, stated as the thing a reader can check by hand:
    // bridge-ui/styles.css has `.bc-status-dot-error`, and has never had
    // `.bc-status-dot-failed`.
    expect(got).not.toBe('failed');
  });
});
