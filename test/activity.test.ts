import { describe, expect, it } from 'vitest';
import {
  activityFromEvent,
  activityFromModel,
  sameActivity,
  IDLE_ACTIVITY,
  type ActivityKind,
} from '../src/store/activity.js';
import { createChatStore, type ChatStoreApi } from '../src/store/ChatStore.js';
import { selectActivity } from '../src/store/selectors.js';
import type { Entry, TurnModel } from '../src/net/types.js';
import type { WireEvent } from '../src/net/wireEvents.js';

let nextId = 1;

/** A wire event with a FRESH event id every time, so nothing here accidentally rides
 *  the reducer's dedup and every assertion is about the activity fold itself. */
function ev(type: string, data: Record<string, unknown> = {}): WireEvent {
  const id = nextId++;
  return { id: String(id), type, data: { type, event_id: id, ...data } };
}

function streamDelta(kind: 'thinking_delta' | 'text_delta'): WireEvent {
  return ev('stream', { stream: { delta: { type: kind, text: 'x' } } });
}

/** A tool call carrying a tool id, which is what makes it pairable with its result.
 *  The transcript-shaped reading needs the id (a call with none is unknowable rather
 *  than pending — see `activityFromModel`), so every fixture that means "a tool is
 *  running" has to supply one. */
function toolCall(name: string, toolId: string): WireEvent {
  return ev('tool_call', { tool_call: { name, tool_id: toolId } });
}

function toolResult(name: string, toolId: string, output?: string): WireEvent {
  return ev('tool_result', { tool_result: { name, tool_id: toolId, output } });
}

function activityIn(store: ChatStoreApi, sessionId: string): ActivityKind {
  return selectActivity(store.getState(), sessionId);
}

describe('activityFromEvent — what an event says the harness is doing', () => {
  it('separates thinking from streaming on all three text-bearing event types', () => {
    expect(activityFromEvent(streamDelta('thinking_delta'))).toEqual({ kind: 'thinking' });
    expect(activityFromEvent(streamDelta('text_delta'))).toEqual({ kind: 'streaming' });
    expect(
      activityFromEvent(ev('block', { block: { block: { type: 'thinking' } } })),
    ).toEqual({ kind: 'thinking' });
    expect(
      activityFromEvent(ev('block', { block: { block: { type: 'text' } } })),
    ).toEqual({ kind: 'streaming' });
    expect(activityFromEvent(ev('thinking', { thinking: { text: 'hm' } }))).toEqual({
      kind: 'thinking',
    });
  });

  it('names the tool on tool_call and returns to streaming on tool_result', () => {
    expect(activityFromEvent(ev('tool_call', { tool_call: { name: 'Bash' } }))).toEqual({
      kind: 'tool',
      name: 'Bash',
    });
    // A tool with no name still means a tool is running; that is the fact worth showing.
    expect(activityFromEvent(ev('tool_call', { tool_call: {} }))).toEqual({
      kind: 'tool',
      name: '',
    });
    expect(activityFromEvent(ev('tool_result', { tool_result: { name: 'Bash' } }))).toEqual({
      kind: 'streaming',
    });
  });

  it('reports null — not idle — for events that say nothing about activity', () => {
    // The distinction this pins: folding these in as `idle` would blank the label
    // between two deltas of the same answer.
    expect(activityFromEvent(ev('user_message'))).toBeNull();
    expect(activityFromEvent(ev('system', { system: { subtype: 'init' } }))).toBeNull();
    expect(activityFromEvent(ev('hook', { hook: { phase: 'awaiting_resolution' } }))).toBeNull();
    expect(activityFromEvent(ev('session_info'))).toBeNull();
  });

  it('goes idle on every terminal signal terminalStateFromTail recognises', () => {
    expect(activityFromEvent(ev('result', { result: { text: 'done' } }))).toEqual(IDLE_ACTIVITY);
    expect(activityFromEvent(ev('turn_complete'))).toEqual(IDLE_ACTIVITY);
    expect(activityFromEvent(ev('close'))).toEqual(IDLE_ACTIVITY);
    expect(activityFromEvent(ev('error', { error: { code: 'PROCESS_DIED' } }))).toEqual(
      IDLE_ACTIVITY,
    );
    expect(activityFromEvent(ev('error', { error: { code: 'TURN_IDLE_TIMEOUT' } }))).toEqual(
      IDLE_ACTIVITY,
    );
  });

  it('leaves a live label alone on an INFORMATIONAL error, which the harness retries past', () => {
    expect(activityFromEvent(ev('error', { error: { code: 'api_error' } }))).toBeNull();
    expect(
      activityFromEvent(ev('error', { error: { code: 'api_retries_exhausted' } })),
    ).toBeNull();
    expect(activityFromEvent(ev('error', { error: { message: 'no code' } }))).toBeNull();
  });

  it('reads a session_state event by whether the state is a running one', () => {
    expect(activityFromEvent(ev('session_state', { state: { state: 'completed' } }))).toEqual(
      IDLE_ACTIVITY,
    );
    expect(activityFromEvent(ev('session_state', { state: { state: 'aborted' } }))).toEqual(
      IDLE_ACTIVITY,
    );
    expect(activityFromEvent(ev('session_state', { state: { state: 'tool_running' } }))).toBeNull();
    expect(activityFromEvent(ev('session_state', {}))).toBeNull();
  });
});

describe('sameActivity — the identity guard the per-token fold rests on', () => {
  it('separates two tool activities by name and decides every other kind by kind', () => {
    expect(sameActivity({ kind: 'tool', name: 'Bash' }, { kind: 'tool', name: 'Bash' })).toBe(true);
    expect(sameActivity({ kind: 'tool', name: 'Bash' }, { kind: 'tool', name: 'Read' })).toBe(
      false,
    );
    expect(sameActivity({ kind: 'streaming' }, { kind: 'streaming' })).toBe(true);
    expect(sameActivity({ kind: 'streaming' }, { kind: 'thinking' })).toBe(false);
    expect(sameActivity(IDLE_ACTIVITY, { kind: 'idle' })).toBe(true);
  });
});

describe('the activity fold in applyTailEvent', () => {
  it('tracks a whole turn: thinking, streaming, a tool, then idle', () => {
    const store = createChatStore();
    const { applyTailEvent } = store.getState().actions;

    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);

    applyTailEvent('br_1', streamDelta('thinking_delta'));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'thinking' });

    applyTailEvent('br_1', streamDelta('text_delta'));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'streaming' });

    applyTailEvent('br_1', toolCall('Bash', 't1'));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Bash' });

    applyTailEvent('br_1', ev('tool_result', { tool_result: { name: 'Bash' } }));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'streaming' });

    applyTailEvent('br_1', ev('result', { result: { text: 'done' } }));
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
  });

  // The regression this pins, and the reason the fold sits AHEAD of the reducer's
  // `if (next === tail) return`: a replayed delta moves no turn, and it is still the
  // best evidence there is that the model is generating right now.
  it('survives an event the turn reducer treats as an idempotent no-op', () => {
    const store = createChatStore();
    const { applyTailEvent } = store.getState().actions;

    const replayed = streamDelta('text_delta');
    applyTailEvent('br_1', replayed);

    applyTailEvent('br_1', toolCall('Bash', 't1'));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Bash' });
    const settledModel = store.getState().turnsBySession.get('br_1');

    // Same event id again: the reducer bails (the transcript is byte-identical), and
    // the label must still move. If this ever stops being a no-op for the reducer the
    // test proves nothing, so the no-op is asserted alongside.
    applyTailEvent('br_1', replayed);
    expect(store.getState().turnsBySession.get('br_1')).toBe(settledModel);
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'streaming' });
  });

  it('keeps the SAME map reference when the activity has not changed', () => {
    const store = createChatStore();
    const { applyTailEvent } = store.getState().actions;

    applyTailEvent('br_1', streamDelta('text_delta'));
    const afterFirst = store.getState().activity;

    // Every further text delta of the same answer says `streaming` again. Without the
    // identity guard each one would replace the map and re-render every subscriber.
    applyTailEvent('br_1', streamDelta('text_delta'));
    applyTailEvent('br_1', streamDelta('text_delta'));
    expect(store.getState().activity).toBe(afterFirst);

    // A tool call is a different activity, so it must NOT be swallowed by the guard.
    applyTailEvent('br_1', toolCall('Bash', 't1'));
    expect(store.getState().activity).not.toBe(afterFirst);

    // ...and so is the same tool under a different name.
    const afterBash = store.getState().activity;
    applyTailEvent('br_1', ev('tool_call', { tool_call: { name: 'Read' } }));
    expect(store.getState().activity).not.toBe(afterBash);
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Read' });
  });

  it('is cleared by setActive, because only the active session has a live stream', () => {
    const store = createChatStore();
    const { applyTailEvent, setActive } = store.getState().actions;

    setActive('br_1');
    applyTailEvent('br_1', toolCall('Bash', 't1'));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Bash' });

    // Navigating away strands br_1 mid-tool. The folded label goes with the stream,
    // and br_1 — which no summary here calls running — gets nothing back on return.
    // The session that IS running is the next test.
    setActive('br_2');
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
    setActive('br_1');
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
  });

  it('leaves the map reference alone when setActive has nothing to clear', () => {
    const store = createChatStore();
    const empty = store.getState().activity;
    store.getState().actions.setActive('br_1');
    expect(store.getState().activity).toBe(empty);
  });

  it('drops a removed session, so a deleted row leaves no entry behind', () => {
    const store = createChatStore();
    const { applyTailEvent, removeSession, upsertSession } = store.getState().actions;
    upsertSession({ sessionId: 'br_1', state: 'tool_running' } as never);
    applyTailEvent('br_1', toolCall('Bash', 't1'));

    removeSession('br_1');
    expect(store.getState().activity.has('br_1')).toBe(false);
  });

  it('reports idle for a session that never streamed, and for no session at all', () => {
    const store = createChatStore();
    expect(selectActivity(store.getState(), 'br_never')).toBe(IDLE_ACTIVITY);
    expect(selectActivity(store.getState(), null)).toBe(IDLE_ACTIVITY);
  });
});

describe('activityFromModel — the same reading, taken off the transcript', () => {
  /** Fold a turn's worth of events into a store and hand back the model they built,
   *  so these assertions run against a materialization of real events rather than a
   *  hand-written TurnModel that could drift from what the reducer actually emits. */
  function modelOf(...events: WireEvent[]): TurnModel | undefined {
    const store = createChatStore();
    for (const event of events) store.getState().actions.applyTailEvent('br_x', event);
    return store.getState().turnsBySession.get('br_x');
  }

  it('agrees with the live fold on what each kind of entry means', () => {
    expect(activityFromModel(modelOf(streamDelta('thinking_delta')))).toEqual({
      kind: 'thinking',
    });
    expect(activityFromModel(modelOf(streamDelta('text_delta')))).toEqual({ kind: 'streaming' });
    expect(activityFromModel(modelOf(toolCall('Bash', 't1')))).toEqual({
      kind: 'tool',
      name: 'Bash',
    });
    expect(
      activityFromModel(modelOf(toolCall('Bash', 't1'), toolResult('Bash', 't1', 'ok'))),
    ).toEqual({ kind: 'streaming' });
  });

  // The live reducer merges a result onto its call and records the arrival twice —
  // `toolResult` (the output) and `eventType` (the frame type). A tool that answered
  // with nothing sets only the second, and reading the first alone would leave the
  // label naming a tool that has already finished.
  it('reads a tool that answered with NO output as finished, not as still running', () => {
    expect(activityFromModel(modelOf(toolCall('Bash', 't1'), toolResult('Bash', 't1')))).toEqual({
      kind: 'streaming',
    });
  });

  // The one case the two readings genuinely cannot agree on, and the reason it is
  // written down: the live fold names the tool because the next frame will correct
  // it, and the transcript has no next frame. An id-less call may have finished an
  // hour ago, so it is left unsaid rather than guessed.
  it('says nothing about a call that can never be paired with its result', () => {
    const idless = ev('tool_call', { tool_call: { name: 'Bash' } });
    expect(activityFromEvent(idless)).toEqual({ kind: 'tool', name: 'Bash' });
    expect(activityFromModel(modelOf(idless))).toBeNull();
    // ...and the scan keeps walking back past it to the newest thing it CAN read.
    expect(activityFromModel(modelOf(streamDelta('thinking_delta'), idless))).toEqual({
      kind: 'thinking',
    });
  });

  it('reads the NEWEST statement, not the first — the same last-wins rule as the fold', () => {
    expect(
      activityFromModel(
        modelOf(streamDelta('thinking_delta'), toolCall('Read', 't1')),
      ),
    ).toEqual({ kind: 'tool', name: 'Read' });
  });

  it('goes idle on a terminal entry, so a finished turn never reads as working', () => {
    expect(
      activityFromModel(
        modelOf(toolCall('Bash', 't1'), ev('result', { result: { text: 'done' } })),
      ),
    ).toEqual(IDLE_ACTIVITY);
  });

  it('says nothing about an empty model, or one holding only the user prompt', () => {
    expect(activityFromModel(undefined)).toBeNull();
    expect(activityFromModel(modelOf(ev('user_message', { user_message: { text: 'hi' } })))).toBeNull();
  });
});

const PAGE_TS = '2026-08-29T05:00:00-07:00';

/** The SERVER-materialized shape, which is not the live reducer's: every event is its
 *  own row keyed `e_<n>`, so a call and its result never merge and the pairing runs on
 *  tool id alone. Built by hand because that shape is what `setTurns` is handed, and a
 *  fixture folded through `applyTailEvent` would quietly test the other one. */
function pageToolCall(eventId: number, name: string, toolId: string): Entry {
  return {
    id: `e_${eventId}`,
    turnId: 'turn_1',
    role: 'assistant',
    kind: 'tool_call',
    source: 'harness',
    eventId,
    ts: PAGE_TS,
    eventType: 'tool_call',
    toolName: name,
    toolId,
  };
}

function pageResult(eventId: number): Entry {
  return {
    id: `e_${eventId}`,
    turnId: 'turn_1',
    role: 'assistant',
    kind: 'result',
    source: 'harness',
    eventId,
    ts: PAGE_TS,
    eventType: 'result',
  };
}

function pageWith(sessionId: string, ...entries: Entry[]): TurnModel {
  return {
    sessionId,
    turns: [{ id: 'turn_1', role: 'assistant', ts: PAGE_TS, entryIds: entries.map((e) => e.id) }],
    entries: Object.fromEntries(entries.map((e) => [e.id, e])),
    validator: { maxEventId: entries.length, eventCount: entries.length, updatedAt: PAGE_TS },
    more: false,
  };
}

describe('setActive re-derives the incoming label from that session\'s transcript', () => {
  /** A summary row carrying nothing but the two fields these assertions read. */
  function running(sessionId: string, state: string) {
    return { sessionId, state } as never;
  }

  it('fills the label in on the switch instead of waiting for the next frame', () => {
    const store = createChatStore();
    const { applyTailEvent, setActive, upsertSession } = store.getState().actions;
    upsertSession(running('br_1', 'tool_running'));

    setActive('br_1');
    applyTailEvent('br_1', toolCall('Bash', 't1'));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Bash' });

    // The regression this pins: br_1 is still running its Bash call, and returning to
    // it used to show a blank status line until the next frame landed — on a long tool
    // call, minutes of a chat that looks idle while it works.
    setActive('br_2');
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
    setActive('br_1');
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Bash' });
  });

  it('re-derives rather than restores, so the value cannot outlive the turn it described', () => {
    const store = createChatStore();
    const { applyTailEvent, setActive, upsertSession } = store.getState().actions;
    upsertSession(running('br_1', 'tool_running'));

    setActive('br_1');
    applyTailEvent('br_1', toolCall('Bash', 't1'));
    setActive('br_2');

    // The turn ended while br_1 was in the background — the frame still reaches the
    // reducer, because the transcript is folded for whichever session it names. A
    // KEPT label would come back saying `Bash`; a derived one reads the ending.
    applyTailEvent('br_1', ev('result', { result: { text: 'done' } }));
    setActive('br_1');
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
  });

  it('derives nothing for a session the server no longer calls running', () => {
    const store = createChatStore();
    const { applyTailEvent, setActive, upsertSession } = store.getState().actions;
    upsertSession(running('br_1', 'tool_running'));
    setActive('br_1');
    applyTailEvent('br_1', toolCall('Bash', 't1'));

    // The summary settles while br_1 sits in the background. Its transcript still ends
    // on an unpaired tool call — the turn's last frames never arrived — and the gate on
    // the state is the only thing standing between that and a permanent `· Bash`.
    setActive('br_2');
    upsertSession(running('br_1', 'completed'));
    setActive('br_1');
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
  });

  it('trusts a terminal tail over a running summary, exactly as effectiveState does', () => {
    const store = createChatStore();
    const { applyTailEvent, setActive, upsertSession } = store.getState().actions;
    // The F1 case: the server strands the state at tool_running, and the transcript
    // has already carried the turn's ending. The tail wins.
    upsertSession(running('br_1', 'tool_running'));
    setActive('br_1');
    applyTailEvent('br_1', toolCall('Bash', 't1'));
    applyTailEvent('br_1', ev('result', { result: { text: 'done' } }));

    setActive('br_2');
    setActive('br_1');
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
  });

  it('fills the label in for a COLD session, when the page lands after the switch', () => {
    const store = createChatStore();
    const { setActive, setTurns, upsertSession } = store.getState().actions;
    upsertSession(running('br_1', 'tool_running'));

    // Nothing warm to read: this is every session after a reload, which is exactly
    // when a user is most likely to be looking for what is running.
    setActive('br_1');
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);

    setTurns('br_1', pageWith('br_1', pageToolCall(1, 'Bash', 't1')));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Bash' });
  });

  it('labels only the ACTIVE session, so a prefetched page stays silent', () => {
    const store = createChatStore();
    const { setActive, setTurns, upsertSession } = store.getState().actions;
    upsertSession(running('br_2', 'tool_running'));
    setActive('br_1');

    // The prefetcher warms sessions the user has only hovered. Labelling one would put
    // an entry in a map whose whole invariant is that it holds the active session alone.
    setTurns('br_2', pageWith('br_2', pageToolCall(1, 'Bash', 't1')));
    expect(store.getState().activity.has('br_2')).toBe(false);
  });

  it('leaves a live label alone when a page arrives behind it', () => {
    const store = createChatStore();
    const { applyTailEvent, setActive, setTurns, upsertSession } = store.getState().actions;
    upsertSession(running('br_1', 'tool_running'));
    setActive('br_1');
    applyTailEvent('br_1', toolCall('Read', 't9'));
    const folded = store.getState().activity;

    // The page is a snapshot the stream has already moved past. The fold outranks it,
    // and saying so must not even replace the map.
    setTurns('br_1', pageWith('br_1', pageToolCall(1, 'Bash', 't1')));
    expect(store.getState().activity).toBe(folded);
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Read' });
  });

  it('reconciles against the INCOMING page, not the model it replaces', () => {
    const store = createChatStore();
    const { setActive, setTurns, upsertSession } = store.getState().actions;
    // The F1 case, arriving by page: the summary is stranded at tool_running and the
    // page carries the ending. Reading the terminal check off the store would ask the
    // model this page is replacing — which has no ending on it — and label the session
    // as running a tool it finished before the switch.
    upsertSession(running('br_1', 'tool_running'));
    setActive('br_1');
    setTurns('br_1', pageWith('br_1', pageToolCall(1, 'Bash', 't1'), pageResult(2)));
    expect(activityIn(store, 'br_1')).toEqual(IDLE_ACTIVITY);
  });

  it('keeps the map reference when the re-derived label equals the one already held', () => {
    const store = createChatStore();
    const { applyTailEvent, setActive, upsertSession } = store.getState().actions;
    upsertSession(running('br_1', 'tool_running'));
    setActive('br_1');
    applyTailEvent('br_1', toolCall('Bash', 't1'));
    const folded = store.getState().activity;

    // Re-selecting the session already active re-derives the same answer. Replacing the
    // map to say so would re-render every subscriber to tell them nothing changed.
    setActive('br_1');
    expect(store.getState().activity).toBe(folded);
  });
});
