import { describe, expect, it, vi } from 'vitest';
import { SyncEngine } from '../src/sync/SyncEngine.js';
import { createChatStore } from '../src/store/ChatStore.js';
import type { ApiClient } from '../src/net/ApiClient.js';
import type { SessionCache } from '../src/cache/SessionCache.js';
import type { TurnModel, Validator } from '../src/net/types.js';

function modelWith(sessionId: string, validator: Validator): TurnModel {
  return { sessionId, turns: [], entries: {}, validator, more: false };
}

function setup(activeId: string | null) {
  const store = createChatStore();
  const sid = 'br_running';
  // A warm/cached tail for a running-but-UNSELECTED session, validator {5,5}.
  store.getState().actions.setTurns(sid, modelWith(sid, { maxEventId: 5, eventCount: 5, updatedAt: '' }));
  if (activeId) store.getState().actions.setActive(activeId);

  const getValidators = vi.fn(async () => ({
    // Server has advanced past the cached tail (running session keeps producing).
    [sid]: { maxEventId: 6, eventCount: 6, updatedAt: '' } as Validator,
  }));
  const getMessages = vi.fn(async () => ({
    model: modelWith(sid, { maxEventId: 6, eventCount: 6, updatedAt: '' }),
  }));
  const api = { getValidators, getMessages } as unknown as ApiClient;
  const cache = { isEnabled: false, putTurns: vi.fn(async () => {}) } as unknown as SessionCache;
  const engine = new SyncEngine({ store, api, cache });
  return { store, engine, sid, getValidators, getMessages };
}

describe('SyncEngine.sweepValidators — idle over-poll fix', () => {
  it('an UNSELECTED running session gets validators only, NO tail fetch', async () => {
    const { engine, getValidators, getMessages } = setup(null);
    await engine.sweepValidators();
    expect(getValidators).toHaveBeenCalledTimes(1); // cheap check ran
    expect(getMessages).not.toHaveBeenCalled(); // no ~500 KB tail pull
  });

  it('pulls the tail only once the session is the active/open one', async () => {
    const { store, engine, sid, getMessages } = setup(null);
    await engine.sweepValidators();
    expect(getMessages).not.toHaveBeenCalled();

    // Select it — now its tail is displayed and must be repaired.
    store.getState().actions.setActive(sid);
    await engine.sweepValidators();
    expect(getMessages).toHaveBeenCalledTimes(1);
  });
});
