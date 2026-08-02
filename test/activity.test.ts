import { describe, expect, it } from 'vitest';
import {
  activityFromEvent,
  sameActivity,
  IDLE_ACTIVITY,
  type ActivityKind,
} from '../src/store/activity.js';
import { createChatStore, type ChatStoreApi } from '../src/store/ChatStore.js';
import { selectActivity } from '../src/store/selectors.js';
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

    applyTailEvent('br_1', ev('tool_call', { tool_call: { name: 'Bash' } }));
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

    applyTailEvent('br_1', ev('tool_call', { tool_call: { name: 'Bash' } }));
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
    applyTailEvent('br_1', ev('tool_call', { tool_call: { name: 'Bash' } }));
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
    applyTailEvent('br_1', ev('tool_call', { tool_call: { name: 'Bash' } }));
    expect(activityIn(store, 'br_1')).toEqual({ kind: 'tool', name: 'Bash' });

    // Navigating away strands br_1 mid-tool. Coming back must not re-show `· Bash`
    // for a tool that stopped when the stream detached.
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
    applyTailEvent('br_1', ev('tool_call', { tool_call: { name: 'Bash' } }));

    removeSession('br_1');
    expect(store.getState().activity.has('br_1')).toBe(false);
  });

  it('reports idle for a session that never streamed, and for no session at all', () => {
    const store = createChatStore();
    expect(selectActivity(store.getState(), 'br_never')).toBe(IDLE_ACTIVITY);
    expect(selectActivity(store.getState(), null)).toBe(IDLE_ACTIVITY);
  });
});
