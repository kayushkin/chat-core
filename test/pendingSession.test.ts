import { describe, expect, it } from 'vitest';
import { createChatStore } from '../src/store/ChatStore.js';

// `usePendingSession` is a bare `useStore(store, s => s.pending)` selector, so what is
// worth testing is the store state it reads. The point of exposing it at all is that
// `openPending` sets `activeId` to null: through `useActiveSession` alone, "a new chat is
// open and unsent" and "nothing is selected" are the same value, and dashv2 drew both as
// an empty pane. These tests pin the four facts a consumer of the hook depends on.

const store = () => createChatStore();

describe('pending session — what usePendingSession() reads', () => {
  it('starts null: a cold store has no pending pane until something opens one', () => {
    expect(store().getState().pending).toBeNull();
  });

  it('openPending(opts) carries the instance/harness the first send will create on', () => {
    const s = store();
    s.getState().actions.openPending({ instanceId: 'inst-cc-local', harness: 'claude_code' });
    const pending = s.getState().pending;
    expect(pending?.instanceId).toBe('inst-cc-local');
    expect(pending?.harness).toBe('claude_code');
    expect(pending?.clientId).toMatch(/^pending_/);
  });

  it('openPending() with nothing recorded still opens a pane — a first run has no prefs', () => {
    const s = store();
    s.getState().actions.openPending();
    const pending = s.getState().pending;
    expect(pending).not.toBeNull();
    // No invented target: the keys are absent rather than undefined, so `createSession`
    // is called with no instance instead of one the user never chose.
    expect(pending && 'instanceId' in pending).toBe(false);
    expect(pending && 'harness' in pending).toBe(false);
  });

  it('openPending nulls activeId — which is why the pending pane needs its own selector', () => {
    const s = store();
    s.getState().actions.setActive('br_old');
    s.getState().actions.openPending({ instanceId: 'inst-cc-local' });
    expect(s.getState().activeId).toBeNull();
    expect(s.getState().pending).not.toBeNull();
  });

  it('setActive alone does NOT clear pending: selecting a session must clear it too', () => {
    // useActiveSession().select() calls setActive AND clearPending. A UI that swaps the
    // active id by any other route leaves a stale pending target behind, and the next
    // lazy create would aim at the instance of a new chat the user walked away from.
    const s = store();
    s.getState().actions.openPending({ instanceId: 'inst-cc-local' });
    s.getState().actions.setActive('br_real');
    expect(s.getState().pending).not.toBeNull();

    s.getState().actions.clearPending();
    expect(s.getState().pending).toBeNull();
    expect(s.getState().activeId).toBe('br_real');
  });
});
