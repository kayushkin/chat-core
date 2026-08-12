import { describe, expect, it } from 'vitest';
import { selectTimeline } from '../src/store/selectors.js';
import type { Entry, TurnModel } from '../src/net/types.js';

function entry(over: Partial<Entry> & Pick<Entry, 'id' | 'kind' | 'eventId' | 'turnId'>): Entry {
  return {
    role: 'assistant',
    source: 'harness',
    ts: '2026-07-27T14:00:00-07:00',
    duplicate: false,
    primary: true,
    ...over,
  };
}

/** A parent's task_started narration. */
function taskStarted(
  over: Partial<Entry> & Pick<Entry, 'id' | 'eventId' | 'turnId' | 'taskId'>,
): Entry {
  return entry({
    role: 'system',
    kind: 'system',
    subtype: 'task_started',
    taskType: 'local_agent',
    ...over,
  });
}

/** A frame that closes a task out. */
function taskClosed(
  over: Partial<Entry> & Pick<Entry, 'id' | 'eventId' | 'turnId' | 'taskId' | 'taskStatus'>,
): Entry {
  return entry({ role: 'system', kind: 'system', subtype: 'task_notification', ...over });
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

const labels = (m: TurnModel, turn = 0) =>
  selectTimeline(m).turns[turn]!.children.map((c) => c.label);

describe('selectTimeline — one flat, chronological row per thing this session did', () => {
  it('returns an empty view for no model', () => {
    const tl = selectTimeline(undefined);
    expect(tl.count).toBe(0);
    expect(tl.items).toEqual([]);
    expect(tl.turns).toEqual([]);
  });

  it('groups events by turn, header first, in order', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'do X' }),
      entry({ id: 'a1', turnId: 't1', kind: 'text', eventId: 2, text: 'sure' }),
      entry({ id: 'u2', turnId: 't2', role: 'user', kind: 'text', eventId: 3, text: 'now Y' }),
      entry({ id: 'a2', turnId: 't2', kind: 'text', eventId: 4, text: 'ok' }),
    ]);
    const tl = selectTimeline(m);
    expect(tl.count).toBe(4);
    expect(tl.turns.map((t) => t.turnId)).toEqual(['t1', 't2']);
    expect(tl.turns[0]!.header.label).toBe('Turn');
    expect(tl.turns[0]!.header.icon).toBe('▶'); // first sighting of t1
    expect(labels(m)).toEqual(['Text']);
  });

  it('is memoized on model identity', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'x' }),
    ]);
    expect(selectTimeline(m)).toBe(selectTimeline(m));
  });
});

describe('a task contributes two rows: a spawn and a finish', () => {
  it('puts each where it happened, with the session between them untouched', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A', text: 'Find the button' }),
      // The parent's own work, while the subagent runs. It is not "inside" the
      // task and must not move.
      entry({ id: 'p1', turnId: 't1', role: 'tool', kind: 'tool_call', eventId: 3, toolName: 'Read' }),
      taskClosed({
        id: 's2',
        turnId: 't1',
        eventId: 4,
        taskId: 'A',
        taskStatus: 'completed',
        taskSummary: 'It is in Sidebar.tsx',
      }),
      entry({ id: 'p2', turnId: 't1', kind: 'text', eventId: 5, text: 'done' }),
    ]);
    expect(labels(m)).toEqual(['Task started', 'Read', 'Task finished', 'Text']);

    const rows = selectTimeline(m).turns[0]!.children;
    expect(rows[0]!.detail).toBe('Find the button'); // what it was asked to do
    expect(rows[2]!.detail).toBe('It is in Sidebar.tsx'); // what it reported
    expect(rows[0]!.tone).toBe('task-start');
    expect(rows[2]!.tone).toBe('task-done');
  });

  it('leaves a running task with a spawn and no finish', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A', text: 'still working' }),
    ]);
    expect(labels(m)).toEqual(['Task started']);
  });

  it('draws failed and cancelled apart — cancelled is not an error', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A' }),
      taskClosed({ id: 's2', turnId: 't1', eventId: 3, taskId: 'A', taskStatus: 'failed' }),
      taskStarted({ id: 's3', turnId: 't1', eventId: 4, taskId: 'B' }),
      taskClosed({
        id: 's4',
        turnId: 't1',
        eventId: 5,
        taskId: 'B',
        taskStatus: 'cancelled',
        text: 'the harness process exited before this task reported a status',
      }),
    ]);
    const rows = selectTimeline(m).turns[0]!.children;
    expect(rows[1]!.tone).toBe('task-err');
    expect(rows[3]!.tone).toBe('task-cancelled');
    expect(rows[3]!.label).toBe('Task cancelled');
    // A derived close says why; nothing else in the stream does.
    expect(rows[3]!.detail).toBe('the harness process exited before this task reported a status');
  });

  it('leaves a task open on a status it does not recognize', () => {
    // A harness that invents a status must not silently close a running task.
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A' }),
      taskClosed({ id: 's2', turnId: 't1', eventId: 3, taskId: 'A', taskStatus: 'quiesced' }),
    ]);
    expect(labels(m)).toEqual(['Task started']);
  });
});

describe('concurrent subagents', () => {
  // The shape measured in session br_1785171126409277953: four subagents at
  // once, rows interleaved event by event. The old selector tracked scope in a
  // single `currentTaskId` scalar, so rows landed under whichever task started
  // last, one subagent's completion stamped its status onto another's header,
  // and the first finish dropped every still-running task's rows out to the
  // turn — the reported symptom.
  const m = model([
    entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
    taskStarted({ id: 'sA', turnId: 't1', eventId: 2, taskId: 'A', text: 'subagent A' }),
    taskStarted({ id: 'sB', turnId: 't1', eventId: 3, taskId: 'B', text: 'subagent B' }),
    taskClosed({
      id: 'sA2',
      turnId: 't1',
      eventId: 4,
      taskId: 'A',
      taskStatus: 'completed',
      taskSummary: 'A is done',
    }),
    // B is still running here, and the parent keeps working.
    entry({ id: 'p1', turnId: 't1', role: 'tool', kind: 'tool_call', eventId: 5, toolName: 'Bash' }),
    taskClosed({
      id: 'sB2',
      turnId: 't1',
      eventId: 6,
      taskId: 'B',
      taskStatus: 'completed',
      taskSummary: 'B is done',
    }),
  ]);

  it('closes the task that actually finished, and only that one', () => {
    const rows = selectTimeline(m).turns[0]!.children;
    expect(rows.map((r) => [r.label, r.taskId])).toEqual([
      ['Task started', 'A'],
      ['Task started', 'B'],
      ['Task finished', 'A'],
      ['Bash', undefined],
      ['Task finished', 'B'],
    ]);
  });

  it('gives each task its own report', () => {
    const rows = selectTimeline(m).turns[0]!.children;
    expect(rows[2]!.detail).toBe('A is done');
    expect(rows[4]!.detail).toBe('B is done');
  });
});

describe('what belongs to somebody else', () => {
  it("drops a subagent's own rows: they are not this session's work", () => {
    // The bridge server routes these into the subagent's own session. One that
    // lands here was kept on the parent by the fail-safe for a frame whose
    // task_started was missed — recorded rather than dropped, but still another
    // session's row.
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A' }),
      entry({
        id: 'x1',
        turnId: 't1',
        role: 'tool',
        kind: 'tool_call',
        eventId: 3,
        toolName: 'ReadInsideSubagent',
        harnessParentId: 'toolu_A',
      }),
      entry({ id: 'p1', turnId: 't1', role: 'tool', kind: 'tool_call', eventId: 4, toolName: 'Bash' }),
    ]);
    expect(labels(m)).toEqual(['Task started', 'Bash']);
  });

  it('drops task_progress — the subagent narrating its own tool calls', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A' }),
      entry({
        id: 's2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_progress',
        taskId: 'A',
        lastToolName: 'Bash',
        text: 'Running List repo files',
      }),
      entry({
        id: 's3',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 4,
        subtype: 'task_progress',
        taskId: 'A',
        lastToolName: 'Bash',
        text: 'Running Check log store db',
      }),
    ]);
    expect(labels(m)).toEqual(['Task started']);
  });
});

describe('the harness repeats itself', () => {
  it('shows one spawn for a task announced twice', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A', text: 'probe' }),
      taskStarted({ id: 's2', turnId: 't1', eventId: 3, taskId: 'A', text: 'probe' }),
    ]);
    expect(labels(m)).toEqual(['Task started']);
  });

  it('shows one finish for a close narrated twice, and takes the later summary', () => {
    // Measured: task_updated lands first with the status, task_notification a
    // moment later with the report. Two rows would say the task finished twice.
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A' }),
      entry({
        id: 's2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_updated',
        taskId: 'A',
        taskStatus: 'completed',
      }),
      taskClosed({
        id: 's3',
        turnId: 't1',
        eventId: 4,
        taskId: 'A',
        taskStatus: 'completed',
        taskSummary: 'what it actually did',
      }),
    ]);
    const rows = selectTimeline(m).turns[0]!.children;
    expect(rows.map((r) => r.label)).toEqual(['Task started', 'Task finished']);
    expect(rows[1]!.detail).toBe('what it actually did');
  });

  it('moves the finish down when a task resumes and closes again', () => {
    // Measured on a real subagent: it reported completed, was re-announced
    // thirty seconds later, worked on, and closed again. Anchoring the row on
    // the FIRST close drew "Task finished" above work the subagent had not
    // done yet.
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A', text: 'demo' }),
      taskClosed({
        id: 's2',
        turnId: 't1',
        eventId: 3,
        taskId: 'A',
        taskStatus: 'completed',
        taskSummary: 'the 40-second wait is still running',
      }),
      // It resumes. Same task id, a second announcement.
      taskStarted({ id: 's3', turnId: 't1', eventId: 4, taskId: 'A', text: 'demo' }),
      // The parent works while the resumed task runs.
      entry({
        id: 'p1',
        turnId: 't1',
        role: 'tool',
        kind: 'tool_call',
        eventId: 5,
        toolName: 'Bash',
      }),
      taskClosed({
        id: 's4',
        turnId: 't1',
        eventId: 6,
        taskId: 'A',
        taskStatus: 'completed',
        taskSummary: 'counted 34 TypeScript files',
      }),
    ]);
    const rows = selectTimeline(m).turns[0]!.children;
    // Still one spawn and one finish — but the finish is now BELOW the work.
    expect(rows.map((r) => r.label)).toEqual(['Task started', 'Bash', 'Task finished']);
    expect(rows[2]!.detail).toBe('counted 34 TypeScript files');
    expect(rows[2]!.entryId).toBe('s4');
  });
});

describe('the link to the subagent', () => {
  it("carries the session id on both of a task's rows", () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({
        id: 's1',
        turnId: 't1',
        eventId: 2,
        taskId: 'A',
        subagentSessionId: 'br_sub',
        subagentType: 'Explore',
      }),
      taskClosed({
        id: 's2',
        turnId: 't1',
        eventId: 3,
        taskId: 'A',
        taskStatus: 'completed',
        subagentSessionId: 'br_sub',
      }),
    ]);
    const rows = selectTimeline(m).turns[0]!.children;
    expect(rows[0]!.subagentSessionId).toBe('br_sub');
    expect(rows[0]!.subagentType).toBe('Explore');
    expect(rows[1]!.subagentSessionId).toBe('br_sub');
  });

  it('leaves the link empty for a task that has no session', () => {
    // A backgrounded shell gets the same task frames a subagent does and
    // deliberately never gets a session. Empty is the answer, not a gap.
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      taskStarted({ id: 's1', turnId: 't1', eventId: 2, taskId: 'A', taskType: 'local_bash', text: 'sleep 2' }),
    ]);
    const row = selectTimeline(m).turns[0]!.children[0]!;
    expect(row.label).toBe('Task started');
    expect(row.taskType).toBe('local_bash');
    expect(row.subagentSessionId).toBeUndefined();
  });
});

describe('tool calls', () => {
  it('does not spin forever on a tool call that can never be paired', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      entry({
        id: 'evt_9',
        turnId: 't1',
        role: 'tool',
        kind: 'tool_call',
        eventId: 2,
        toolName: 'Bash',
        unpairable: true,
      }),
    ]);
    const row = selectTimeline(m).turns[0]!.children[0]!;
    expect(row.tone).toBe('tool-unknown');
    expect(row.tone).not.toBe('tool');
  });

  it('marks a call done when its result is a SEPARATE row (server-materialized page)', () => {
    // GET /messages keys entries by event id and never merges a result onto its
    // call — the tool id lives only in raw. Reading `toolResult` alone drew a ⚙
    // on every cold-loaded call, forever.
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      entry({
        id: 'e_2',
        turnId: 't1',
        role: 'tool',
        kind: 'tool_call',
        eventId: 2,
        toolName: 'Bash',
        raw: { tool_call: { tool_id: 'toolu_1', name: 'Bash' } },
      }),
      entry({
        id: 'e_3',
        turnId: 't1',
        role: 'tool',
        kind: 'tool_result',
        eventId: 3,
        toolResult: 'ok',
        raw: { tool_result: { tool_id: 'toolu_1', output: 'ok' } },
      }),
    ]);
    const call = selectTimeline(m).turns[0]!.children.find((c) => c.entryId === 'e_2');
    expect(call?.tone).toBe('tool-done');
    expect(call?.icon).toBe('✓');
  });

  it('still shows ⚙ for a pairable call whose result has not arrived', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      entry({
        id: 'e_2',
        turnId: 't1',
        role: 'tool',
        kind: 'tool_call',
        eventId: 2,
        toolName: 'Bash',
        raw: { tool_call: { tool_id: 'toolu_1', name: 'Bash' } },
      }),
    ]);
    const row = selectTimeline(m).turns[0]!.children[0]!;
    expect(row.tone).toBe('tool');
    expect(row.icon).toBe('⚙');
  });
});
