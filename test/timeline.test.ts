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
        raw: { task_id: 'task-A', description: 'Explore repo' },
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
        raw: { task_id: 'task-A' }, // no description yet
      }),
      entry({
        id: 'sys2',
        turnId: 't1',
        role: 'system',
        kind: 'system',
        eventId: 3,
        subtype: 'task_progress',
        raw: { task_id: 'task-A', description: 'Building index' },
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
