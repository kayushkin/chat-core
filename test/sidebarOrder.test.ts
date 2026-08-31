import { describe, expect, it } from 'vitest';
import { createChatStore, type ChatStoreApi } from '../src/store/ChatStore.js';
import { visibleSessions } from '../src/store/selectors.js';
import type { SessionSummary } from '../src/net/types.js';
import type { WireEvent } from '../src/net/wireEvents.js';

// The sidebar's ORDER STAMP (ChatState.listOrderStampBySession): the row order
// moves only when a response's final text lands in the chat, never merely because
// a session is working.
//
// What was wrong: `visibleSessions` ordered by `updatedAt`, which the server bumps
// on every event. With several sessions running at once the list-stream upserts
// arrived interleaved, so the rows leapfrogged each other continuously and the
// sidebar could not be read while it was working — the complaint that opened this.
//
// Two wires can carry a turn's ending and both are covered here: the summary state
// transition (`upsertSession`, the only signal for a BACKGROUND session) and a
// terminal event on the live tail (`applyTailEvents`, the only signal when the
// server strands the summary state — the F1 defect).

function summary(
  over: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>,
): SessionSummary {
  return {
    state: 'idle',
    harness: 'claudecode',
    instanceId: 'inst1',
    type: 'interactive',
    purpose: 'chat',
    mode: 'events',
    folderName: '',
    displayName: over.sessionId,
    agentId: '',
    updatedAt: '2026-08-30T10:00:00+00:00',
    createdAt: '2026-08-30T09:00:00+00:00',
    ...over,
  };
}

function orderOf(store: ChatStoreApi): string[] {
  return visibleSessions(store.getState()).flatMap((g) => g.sessions.map((s) => s.sessionId));
}

/** Three sessions seeded newest-first: a (12:00), b (11:00), c (10:00). */
function seedThree(states: [string, string, string] = ['idle', 'idle', 'idle']): ChatStoreApi {
  const store = createChatStore();
  store.getState().actions.setSessions([
    summary({ sessionId: 'a', state: states[0], updatedAt: '2026-08-30T12:00:00+00:00' }),
    summary({ sessionId: 'b', state: states[1], updatedAt: '2026-08-30T11:00:00+00:00' }),
    summary({ sessionId: 'c', state: states[2], updatedAt: '2026-08-30T10:00:00+00:00' }),
  ]);
  return store;
}

let nextEventId = 1;
function ev(type: string, timestamp: string, data: Record<string, unknown> = {}): WireEvent {
  const id = nextEventId++;
  return { id: String(id), type, data: { type, event_id: id, timestamp, ...data } };
}

describe('running sessions hold their place', () => {
  it('a working session does not move on the per-event summary bumps', () => {
    const store = seedThree(['tool_running', 'tool_running', 'idle']);
    expect(orderOf(store)).toEqual(['a', 'b', 'c']);

    // The exact wire traffic of two concurrent sessions: interleaved upserts, each
    // with a fresher updatedAt than every row above it. Under updatedAt ordering
    // these four frames reorder the list four times.
    const { upsertSession } = store.getState().actions;
    upsertSession(summary({ sessionId: 'b', state: 'tool_running', updatedAt: '2026-08-30T12:01:00+00:00' }));
    expect(orderOf(store)).toEqual(['a', 'b', 'c']);
    upsertSession(summary({ sessionId: 'a', state: 'tool_running', updatedAt: '2026-08-30T12:02:00+00:00' }));
    upsertSession(summary({ sessionId: 'b', state: 'tool_running', updatedAt: '2026-08-30T12:03:00+00:00' }));
    upsertSession(summary({ sessionId: 'a', state: 'model_generating', updatedAt: '2026-08-30T12:04:00+00:00' }));
    expect(orderOf(store)).toEqual(['a', 'b', 'c']);
  });

  it("the user's own send does not move the row either", () => {
    // Deliberate, not an accident of the mechanism: the order changes on a final
    // RESPONSE text, and a send is not one. The session being written to is
    // selected, so it does not need to be on top to be found.
    const store = seedThree(['idle', 'idle', 'idle']);
    store.getState().actions.upsertSession(
      summary({ sessionId: 'c', state: 'running', updatedAt: '2026-08-30T13:00:00+00:00' }),
    );
    expect(orderOf(store)).toEqual(['a', 'b', 'c']);
  });

  it('a rename or other settled-state bump does not move the row', () => {
    const store = seedThree();
    store.getState().actions.upsertSession(
      summary({ sessionId: 'c', displayName: 'renamed', updatedAt: '2026-08-30T13:00:00+00:00' }),
    );
    expect(orderOf(store)).toEqual(['a', 'b', 'c']);
  });
});

describe('a finished response is what moves a row', () => {
  it('running → settled lifts the session to the top', () => {
    const store = seedThree(['idle', 'idle', 'tool_running']);
    store.getState().actions.upsertSession(
      summary({ sessionId: 'c', state: 'completed', updatedAt: '2026-08-30T13:00:00+00:00' }),
    );
    expect(orderOf(store)).toEqual(['c', 'a', 'b']);
  });

  it('a question surfacing (running → awaiting_user) counts as final text', () => {
    // The turn's last output IS the question — it is in the chat, and the row
    // moving up is what makes an unwatched session's ask findable.
    const store = seedThree(['idle', 'tool_running', 'idle']);
    store.getState().actions.upsertSession(
      summary({ sessionId: 'b', state: 'awaiting_user', updatedAt: '2026-08-30T13:00:00+00:00' }),
    );
    expect(orderOf(store)).toEqual(['b', 'a', 'c']);
  });

  it('a session seen for the first time enters at its recency position', () => {
    const store = seedThree();
    store.getState().actions.upsertSession(
      summary({ sessionId: 'fresh', state: 'starting', updatedAt: '2026-08-30T13:00:00+00:00' }),
    );
    expect(orderOf(store)).toEqual(['fresh', 'a', 'b', 'c']);
  });
});

describe('the tail wire — the ending the summary can strand (F1)', () => {
  it('a result event on the live tail lifts the session, with no summary transition', () => {
    const store = seedThree(['idle', 'idle', 'tool_running']);
    // The summary stays pinned at tool_running forever — the F1 strand. The
    // transcript still carries the ending, and it is the only wire that does.
    store.getState().actions.applyTailEvent(
      'c',
      ev('result', '2026-08-30T13:00:00+00:00', { result: { text: 'done' } }),
    );
    expect(orderOf(store)).toEqual(['c', 'a', 'b']);
  });

  it('a REPLAYED old ending cannot move a row back down', () => {
    // Opening a session replays its whole current turn, ending included. The
    // stamp advances by max, so yesterday's result is a no-op against today's.
    const store = seedThree();
    store.getState().actions.applyTailEvent(
      'c',
      ev('result', '2026-08-29T13:00:00+00:00', { result: { text: 'old' } }),
    );
    expect(orderOf(store)).toEqual(['a', 'b', 'c']);
  });

  it('a stream delta on the tail moves nothing', () => {
    const store = seedThree(['idle', 'idle', 'tool_running']);
    store.getState().actions.applyTailEvent(
      'c',
      ev('stream', '2026-08-30T13:00:00+00:00', {
        stream: { delta: { type: 'text_delta', text: 'partial' } },
      }),
    );
    expect(orderOf(store)).toEqual(['a', 'b', 'c']);
  });
});

describe('the stamp survives the list actions', () => {
  it('a full list refresh keeps the frozen order rather than snapping to recency', () => {
    const store = seedThree(['idle', 'tool_running', 'idle']);
    // b finishes → moves to top…
    store.getState().actions.upsertSession(
      summary({ sessionId: 'b', state: 'completed', updatedAt: '2026-08-30T13:00:00+00:00' }),
    );
    expect(orderOf(store)).toEqual(['b', 'a', 'c']);
    // …then a reconnect re-reads the list. Raw recency says a (14:00) first;
    // the held stamps say b is still where its finished response put it.
    store.getState().actions.setSessions([
      summary({ sessionId: 'a', state: 'tool_running', updatedAt: '2026-08-30T14:00:00+00:00' }),
      summary({ sessionId: 'b', state: 'completed', updatedAt: '2026-08-30T13:00:00+00:00' }),
      summary({ sessionId: 'c', state: 'idle', updatedAt: '2026-08-30T10:00:00+00:00' }),
    ]);
    expect(orderOf(store)).toEqual(['b', 'a', 'c']);
  });

  it('a removed session leaves no stamp behind', () => {
    const store = seedThree();
    store.getState().actions.removeSession('b');
    expect(store.getState().listOrderStampBySession.has('b')).toBe(false);
    expect(orderOf(store)).toEqual(['a', 'c']);
  });

  it('an upsert that moves nothing keeps the stamp map reference', () => {
    // The list stream delivers one upsert per event while a session works; a fresh
    // map per upsert would re-run the ordering memo on every one of them.
    const store = seedThree(['tool_running', 'idle', 'idle']);
    const before = store.getState().listOrderStampBySession;
    store.getState().actions.upsertSession(
      summary({ sessionId: 'a', state: 'tool_running', updatedAt: '2026-08-30T13:00:00+00:00' }),
    );
    expect(store.getState().listOrderStampBySession).toBe(before);
  });
});
