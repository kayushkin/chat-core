import { describe, expect, it } from 'vitest';
import { applyEvent, initTailState, type TailState } from '../src/reduce/TurnReducer.js';
import {
  joinSubagentSessions,
  liveStatusFromModel,
  toolCallSummary,
} from '../src/store/liveStatus.js';
import type { SessionSummary } from '../src/net/types.js';
import type { WireEvent } from '../src/net/wireEvents.js';

let nextId = 1;

function ev(type: string, turnId: string, data: Record<string, unknown> = {}): WireEvent {
  const id = nextId++;
  return {
    id: String(id),
    type,
    data: {
      event_id: id,
      type,
      turn_id: turnId,
      timestamp: `2026-08-12T14:00:${String(id % 60).padStart(2, '0')}-07:00`,
      ...data,
    },
  };
}

function apply(events: WireEvent[]): TailState {
  let s = initTailState('br_1');
  for (const e of events) s = applyEvent(s, e);
  return s;
}

function userMsg(turnId: string, text: string): WireEvent {
  return ev('user_message', turnId, { message_id: `u_${turnId}`, result: { text } });
}

function toolCall(turnId: string, toolId: string, name: string, input: unknown): WireEvent {
  return ev('tool_call', turnId, { tool_call: { tool_id: toolId, name, input } });
}

function toolResult(turnId: string, toolId: string, name: string, output: unknown): WireEvent {
  return ev('tool_result', turnId, { tool_result: { tool_id: toolId, name, output } });
}

function summary(sessionId: string, harnessSessionId: string): SessionSummary {
  return {
    sessionId,
    state: 'running',
    harness: 'claude-code',
    instanceId: 'i1',
    type: 'chat',
    purpose: 'subagent',
    mode: '',
    folderName: '',
    displayName: '',
    agentId: '',
    updatedAt: '',
    createdAt: '',
    harnessSessionId,
    managerSessionId: 'br_1',
  };
}

describe('toolCallSummary — one human line per tool call', () => {
  it('picks the field that names what the call does, per tool', () => {
    expect(toolCallSummary('Bash', { command: 'cat thing.txt', description: 'Read it' })).toBe(
      'cat thing.txt',
    );
    expect(toolCallSummary('Read', { file_path: '/tmp/a.go' })).toBe('/tmp/a.go');
    expect(toolCallSummary('Grep', { pattern: 'TODO', path: '/x' })).toBe('TODO');
    expect(toolCallSummary('Task', { description: 'Look at thing', prompt: 'long…' })).toBe(
      'Look at thing',
    );
  });

  it('falls through to the first string field of an unlisted tool, then to JSON', () => {
    expect(toolCallSummary('mcp__thing__do', { target: 'x', count: 3 })).toBe('x');
    expect(toolCallSummary('mcp__thing__do', { count: 3 })).toBe('{"count":3}');
  });

  it('collapses whitespace and caps at 120 chars', () => {
    expect(toolCallSummary('Bash', { command: 'a\n  b\tc' })).toBe('a b c');
    const long = 'x'.repeat(300);
    const out = toolCallSummary('Bash', { command: long });
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('liveStatusFromModel — in-flight tool calls', () => {
  it('lists a call with no result and drops it when the result lands', () => {
    const before = apply([
      userMsg('t1', 'do the thing'),
      toolCall('t1', 'tu1', 'Bash', { command: 'cat thing.txt' }),
    ]);
    const live = liveStatusFromModel(before.model);
    expect(live.toolCalls).toEqual([
      { name: 'Bash', summary: 'cat thing.txt', startedAt: expect.any(String) },
    ]);

    const after = applyEvent(before, toolResult('t1', 'tu1', 'Bash', 'contents'));
    expect(liveStatusFromModel(after.model).toolCalls).toEqual([]);
  });

  it('never lists an unpairable call — it is not pending, it is unknowable', () => {
    const s = apply([
      userMsg('t1', 'go'),
      ev('tool_call', 't1', { tool_call: { name: 'Bash', input: { command: 'x' } } }),
    ]);
    expect(liveStatusFromModel(s.model).toolCalls).toEqual([]);
  });

  it('scopes to the LAST turn: an aborted turn’s unpaired call does not haunt the next', () => {
    const s = apply([
      userMsg('t1', 'first'),
      toolCall('t1', 'tu1', 'Bash', { command: 'killed mid-flight' }),
      userMsg('t2', 'second'),
      toolCall('t2', 'tu2', 'Read', { file_path: '/tmp/a' }),
    ]);
    const live = liveStatusFromModel(s.model);
    expect(live.toolCalls.map((c) => c.name)).toEqual(['Read']);
  });

  it('is memoized per model identity', () => {
    const s = apply([userMsg('t1', 'hi')]);
    expect(liveStatusFromModel(s.model)).toBe(liveStatusFromModel(s.model));
  });
});

describe('liveStatusFromModel — server-materialized pages (call and result as separate rows)', () => {
  // GET /sessions/{id}/messages keys entries by event id and does NOT merge a
  // result onto its call — the tool id lives only in each row's raw payload.
  // This is the shape that made every cold-loaded call read as in flight
  // ("+19 more") the first time the status line met a real session.
  function serverModel(withResult: boolean) {
    const call = {
      id: 'e_100',
      turnId: 't1',
      role: 'assistant' as const,
      kind: 'tool_call' as const,
      source: 'harness' as const,
      eventId: 100,
      ts: '2026-08-12T16:54:10Z',
      toolName: 'Bash',
      toolInput: { command: 'cat thing.txt' },
      raw: { tool_call: { tool_id: 'toolu_1', name: 'Bash' } },
      duplicate: false,
      primary: true,
    };
    const result = {
      id: 'e_101',
      turnId: 't1',
      role: 'assistant' as const,
      kind: 'tool_result' as const,
      source: 'harness' as const,
      eventId: 101,
      ts: '2026-08-12T16:54:12Z',
      toolResult: 'contents',
      raw: { tool_result: { tool_id: 'toolu_1', name: '', output: 'contents' } },
      duplicate: false,
      primary: true,
    };
    const entryIds = withResult ? ['e_100', 'e_101'] : ['e_100'];
    return {
      sessionId: 'br_1',
      turns: [{ id: 't1', role: 'assistant' as const, ts: call.ts, entryIds }],
      entries: withResult ? { e_100: call, e_101: result } : { e_100: call },
      more: false,
    };
  }

  it('lists a genuinely unpaired call', () => {
    expect(liveStatusFromModel(serverModel(false)).toolCalls).toEqual([
      { name: 'Bash', summary: 'cat thing.txt', startedAt: '2026-08-12T16:54:10Z' },
    ]);
  });

  it('pairs by the raw tool id: a call whose result is a separate row is NOT in flight', () => {
    expect(liveStatusFromModel(serverModel(true)).toolCalls).toEqual([]);
  });
});

describe('liveStatusFromModel — todo label (harness todo list)', () => {
  const todos = (items: Array<Record<string, unknown>>) => ({ todos: items });

  it('surfaces the in-progress item, preferring its active form', () => {
    const s = apply([
      userMsg('t1', 'go'),
      toolCall('t1', 'tu1', 'TodoWrite', todos([
        { content: 'Refactor the parser', status: 'in_progress', activeForm: 'Refactoring the parser' },
        { content: 'Run tests', status: 'pending' },
      ])),
    ]);
    expect(liveStatusFromModel(s.model).todo).toEqual({
      text: 'Refactoring the parser',
      sinceTs: expect.any(String),
    });
  });

  it('the LATEST list wins even when it has nothing in progress', () => {
    const s = apply([
      userMsg('t1', 'go'),
      toolCall('t1', 'tu1', 'TodoWrite', todos([{ content: 'a', status: 'in_progress' }])),
      toolCall('t1', 'tu2', 'TodoWrite', todos([{ content: 'a', status: 'completed' }])),
    ]);
    expect(liveStatusFromModel(s.model).todo).toBeUndefined();
  });

  it('persists across turns, unlike the tool-call scope', () => {
    const s = apply([
      userMsg('t1', 'go'),
      toolCall('t1', 'tu1', 'TodoWrite', todos([{ content: 'a', status: 'in_progress' }])),
      userMsg('t2', 'continue'),
    ]);
    expect(liveStatusFromModel(s.model).todo?.text).toBe('a');
  });
});

describe('liveStatusFromModel — subagents', () => {
  function taskStarted(turnId: string, taskId: string, toolUseId: string): WireEvent {
    return ev('system', turnId, {
      system: {
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: toolUseId,
        description: 'find the parser',
        task_type: 'local_agent',
        subagent_type: 'Explore',
      },
    });
  }

  it('lists a started task with its type and description, and claims its Task tool call', () => {
    const s = apply([
      userMsg('t1', 'go'),
      toolCall('t1', 'tu_task', 'Task', { description: 'find the parser', prompt: '…' }),
      taskStarted('t1', 'task_1', 'tu_task'),
    ]);
    const live = liveStatusFromModel(s.model);
    expect(live.subagents).toEqual([
      expect.objectContaining({
        taskId: 'task_1',
        description: 'find the parser',
        subagentType: 'Explore',
        taskType: 'local_agent',
      }),
    ]);
    // The Task call that spawned it is a subagent line, never also a tool line.
    expect(live.toolCalls).toEqual([]);
  });

  it('tracks the subagent’s own last tool from task_progress', () => {
    const s = apply([
      userMsg('t1', 'go'),
      toolCall('t1', 'tu_task', 'Task', { description: 'find the parser' }),
      taskStarted('t1', 'task_1', 'tu_task'),
      ev('system', 't1', {
        system: { subtype: 'task_progress', task_id: 'task_1', last_tool_name: 'Grep' },
      }),
    ]);
    expect(liveStatusFromModel(s.model).subagents[0]?.lastToolName).toBe('Grep');
  });

  it('closes the task on every terminal status the timeline recognizes, and only those', () => {
    for (const [status, closed] of [
      ['completed', true],
      ['failed', true],
      ['cancelled', true],
      ['in_progress', false],
      ['some_future_status', false],
    ] as const) {
      const s = apply([
        userMsg('t1', 'go'),
        toolCall('t1', 'tu_task', 'Task', { description: 'd' }),
        taskStarted('t1', 'task_1', 'tu_task'),
        ev('system', 't1', {
          system: { subtype: 'task_notification', task_id: 'task_1', task_status: status },
        }),
      ]);
      expect(liveStatusFromModel(s.model).subagents.length, status).toBe(closed ? 0 : 1);
    }
  });
});

describe('joinSubagentSessions — the agent-<task_id> id join', () => {
  const task = {
    taskId: 'task_1',
    description: 'find the parser',
    startedAt: '2026-08-12T14:00:00-07:00',
  };

  it('attaches the promoted session by harnessSessionId, never by name', () => {
    const sessions = new Map([
      ['br_sub', summary('br_sub', 'agent-task_1')],
      ['br_other', summary('br_other', 'agent-task_999')],
    ]);
    const joined = joinSubagentSessions([task], sessions);
    expect(joined[0]?.sessionId).toBe('br_sub');
  });

  it('returns the SAME array when nothing joins, so memoized callers keep their reference', () => {
    const input = [task];
    expect(joinSubagentSessions(input, new Map())).toBe(input);
  });
});
