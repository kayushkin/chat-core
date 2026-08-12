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

describe('selectTimeline — event-granular, turn→task grouping', () => {
  it('returns an empty view for no model', () => {
    const tl = selectTimeline(undefined);
    expect(tl.count).toBe(0);
    expect(tl.items).toEqual([]);
    expect(tl.turns).toEqual([]);
  });

  it('groups events by turn, header first, newest turn events in order', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'do X' }),
      entry({ id: 'a1', turnId: 't1', kind: 'text', eventId: 2, text: 'sure' }),
      entry({ id: 'u2', turnId: 't2', role: 'user', kind: 'text', eventId: 3, text: 'now Y' }),
      entry({ id: 'a2', turnId: 't2', kind: 'text', eventId: 4, text: 'ok' }),
    ]);
    const tl = selectTimeline(m);
    expect(tl.count).toBe(4);
    expect(tl.turns.map((t) => t.turnId)).toEqual(['t1', 't2']);
    // Each turn's header is its user 'Turn' row.
    expect(tl.turns[0]!.header.label).toBe('Turn');
    expect(tl.turns[0]!.header.tone).toBe('turn');
    expect(tl.turns[0]!.header.icon).toBe('▶'); // first sighting of t1
    // The assistant text is a standalone child item.
    expect(tl.turns[0]!.children).toHaveLength(1);
    const child = tl.turns[0]!.children[0]!;
    expect(child.type).toBe('item');
    if (child.type === 'item') expect(child.item.label).toBe('Text');
  });

  it('scopes thinking/tool/text under an active task_* span, closing it on result', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'refactor' }),
      entry({
        id: 'sys1',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 2,
        subtype: 'task_started',
        taskId: 'task-A',
        text: 'Explore repo',
      }),
      entry({ id: 'th1', turnId: 't1', kind: 'thinking', eventId: 3, text: 'let me look' }),
      entry({ id: 'tool1', turnId: 't1', role: 'tool', kind: 'tool_call', eventId: 4, toolName: 'grep' }),
      entry({ id: 'a1', turnId: 't1', kind: 'text', eventId: 5, text: 'found it' }),
      entry({ id: 'res1', turnId: 't1', kind: 'result', eventId: 6, text: 'done' }),
    ]);
    const tl = selectTimeline(m);
    expect(tl.count).toBe(6);
    const turn = tl.turns[0]!;
    expect(turn.turnId).toBe('t1');
    expect(turn.header.label).toBe('Turn');

    // children: one task group (task-A) then the standalone Done row (task closed).
    expect(turn.children).toHaveLength(2);
    const taskNode = turn.children[0]!;
    expect(taskNode.type).toBe('task');
    if (taskNode.type === 'task') {
      expect(taskNode.taskId).toBe('task-A');
      expect(taskNode.header.label).toBe('Task');
      expect(taskNode.header.detail).toBe('Explore repo');
      // thinking + tool + assistant text are scoped inside the task span.
      expect(taskNode.children.map((c) => c.label)).toEqual(['Thinking', 'grep', 'Text']);
    }
    const doneNode = turn.children[1]!;
    expect(doneNode.type).toBe('item');
    if (doneNode.type === 'item') {
      expect(doneNode.item.label).toBe('Done'); // result closed the task scope
      expect(doneNode.item.tone).toBe('result');
      expect(doneNode.item.taskId).toBeUndefined();
    }
  });

  it('folds a later task_* event description into the existing task header', () => {
    const m = model([
      entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
      entry({
        id: 'sys1',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 2,
        subtype: 'task_started',
        taskId: 'task-A', // no description yet
      }),
      entry({
        id: 'sys2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_progress',
        taskId: 'task-A',
        text: 'Building index',
      }),
    ]);
    const tl = selectTimeline(m);
    // The two task events collapse to one Task header, its detail folded in later.
    const taskNode = tl.turns[0]!.children[0]!;
    expect(taskNode.type).toBe('task');
    if (taskNode.type === 'task') {
      expect(taskNode.header.detail).toBe('Building index');
      expect(taskNode.children).toHaveLength(0);
    }
  });

  it('is memoized on model identity', () => {
    const m = model([entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'x' })]);
    expect(selectTimeline(m)).toBe(selectTimeline(m));
  });
});

describe('a subagent that finishes says so', () => {
  // Until task_notification was read, a task header looked identical before and
  // after its subagent finished — there was no done tone to reach — and the
  // group went on swallowing every row for the rest of the turn, because the
  // only things that closed a scope were a new turn, a user message, or a
  // result.
  const launched = () => [
    entry({ id: 'u1', turnId: 't1', role: 'user', kind: 'text', eventId: 1, text: 'go' }),
    entry({
      id: 'sys1',
      turnId: 't1',
      role: 'system',
      kind: 'system',
      eventId: 2,
      subtype: 'task_started',
      taskId: 'task-A',
      text: 'Find the button',
    }),
  ];

  it('marks the task done and shows the subagent report, not the launch description', () => {
    const m = model([
      ...launched(),
      entry({
        id: 'sys2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_notification',
        taskId: 'task-A',
        taskStatus: 'completed',
        taskSummary: 'The button is in Sidebar.tsx at line 440.',
      }),
    ]);
    const node = selectTimeline(m).turns[0]!.children[0]!;
    expect(node.type).toBe('task');
    if (node.type === 'task') {
      expect(node.header.tone).toBe('task-done');
      expect(node.header.detail).toBe('The button is in Sidebar.tsx at line 440.');
    }
  });

  it('closes the scope, so later rows are not swallowed by a finished task', () => {
    const m = model([
      ...launched(),
      entry({
        id: 'sys2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_notification',
        taskId: 'task-A',
        taskStatus: 'completed',
        taskSummary: 'done',
      }),
      entry({ id: 'a1', turnId: 't1', kind: 'text', eventId: 4, text: 'after the task' }),
    ]);
    const children = selectTimeline(m).turns[0]!.children;
    expect(children).toHaveLength(2);
    const after = children[1]!;
    expect(after.type).toBe('item');
    if (after.type === 'item') expect(after.item.taskId).toBeUndefined();
  });

  it('reports a failed subagent as failed, not as finished', () => {
    const m = model([
      ...launched(),
      entry({
        id: 'sys2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_notification',
        taskId: 'task-A',
        taskStatus: 'failed',
      }),
    ]);
    const node = selectTimeline(m).turns[0]!.children[0]!;
    if (node.type === 'task') expect(node.header.tone).toBe('task-err');
  });

  it('leaves a task open on a status it does not recognize', () => {
    // A harness that invents a status must not silently close a running task.
    const m = model([
      ...launched(),
      entry({
        id: 'sys2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_updated',
        taskId: 'task-A',
        taskStatus: 'quiesced',
      }),
      entry({ id: 'a1', turnId: 't1', kind: 'text', eventId: 4, text: 'still inside' }),
    ]);
    const node = selectTimeline(m).turns[0]!.children[0]!;
    expect(node.type).toBe('task');
    if (node.type === 'task') {
      expect(node.header.tone).toBe('task-start');
      expect(node.children).toHaveLength(1);
    }
  });

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
    const node = selectTimeline(m).turns[0]!.children[0]!;
    if (node.type === 'item') {
      expect(node.item.tone).toBe('tool-unknown');
      expect(node.item.tone).not.toBe('tool');
    }
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
    const callNode = selectTimeline(m).turns[0]!.children.find(
      (n) => n.type === 'item' && n.item.entryId === 'e_2',
    );
    expect(callNode?.type).toBe('item');
    if (callNode?.type === 'item') {
      expect(callNode.item.tone).toBe('tool-done');
      expect(callNode.item.icon).toBe('✓');
    }
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
    const node = selectTimeline(m).turns[0]!.children[0]!;
    if (node.type === 'item') {
      expect(node.item.tone).toBe('tool');
      expect(node.item.icon).toBe('⚙');
    }
  });
});
