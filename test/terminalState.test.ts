import { describe, expect, it } from 'vitest';
import { terminalStateFromTail } from '../src/reduce/terminalState.js';
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

  it('detects TURN_IDLE_TIMEOUT → failed', () => {
    const m = model([entry({ id: 'e', kind: 'error', eventId: 5, code: 'TURN_IDLE_TIMEOUT' })]);
    expect(terminalStateFromTail(m)).toBe('failed');
  });

  it('detects PROCESS_DIED → failed', () => {
    const m = model([entry({ id: 'e', kind: 'error', eventId: 5, code: 'PROCESS_DIED' })]);
    expect(terminalStateFromTail(m)).toBe('failed');
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
  function seed(sm: SessionSummary, m?: TurnModel) {
    const store = createChatStore();
    store.getState().actions.setSessions([sm]);
    if (m) store.getState().actions.setTurns(sm.sessionId, m);
    return store;
  }

  it("overrides a stale 'tool_running' summary when the tail is terminal", () => {
    const store = seed(
      summary({ sessionId: 's1', state: 'tool_running' }),
      model([entry({ id: 'r', kind: 'result', eventId: 5, text: 'done' })]),
    );
    expect(effectiveState(store.getState(), 's1')).toBe('completed');
  });

  it("maps a terminating TURN_IDLE_TIMEOUT to 'failed'", () => {
    const store = seed(
      summary({ sessionId: 's1', state: 'tool_running' }),
      model([entry({ id: 'e', kind: 'error', eventId: 5, code: 'TURN_IDLE_TIMEOUT' })]),
    );
    expect(effectiveState(store.getState(), 's1')).toBe('failed');
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
