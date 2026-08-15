import { afterEach, describe, expect, it, vi } from 'vitest';

// The per-session SSE resume point. `SyncEngine.lastEventIdFor` answers the
// `Last-Event-ID` the stream reconnects with, and its failure value is
// `undefined` — meaning "send no header, start from the beginning".
//
// That `undefined` was unpinned: replacing the whole expression with
// `String(Math.floor(max))` left the entire suite green, because nothing
// inspected the argument the stream is opened with. The difference matters on
// the wire — `Last-Event-ID: 0` asks the server to resume AFTER event 0, which
// is not the same request as asking for the stream from its start, and a
// session with nothing cached is exactly the one that needs everything.
//
// `sse.js` is mocked rather than served over HTTP: the value under test is an
// ARGUMENT to `connectSessionSSE`, and `connectSessionSSE` turning it into a
// header is that function's own business (and its own case).

const connectSessionSSE = vi.fn();
const connectListSSE = vi.fn();

vi.mock('../src/sync/sse.js', () => ({
  connectSessionSSE: (...args: unknown[]) => connectSessionSSE(...args),
  connectListSSE: (...args: unknown[]) => connectListSSE(...args),
}));

const { SyncEngine } = await import('../src/sync/SyncEngine.js');
const { createChatStore } = await import('../src/store/ChatStore.js');
type Validator = import('../src/net/types.js').Validator;
type TurnModel = import('../src/net/types.js').TurnModel;
type ApiClient = import('../src/net/ApiClient.js').ApiClient;
type SessionCache = import('../src/cache/SessionCache.js').SessionCache;

/** A stream that opens and immediately ends, so the engine records the call and
 *  then waits on its reconnect backoff instead of spinning. */
async function* noEvents(): AsyncGenerator<never> {
  return;
}

function modelWith(sessionId: string, validator: Validator): TurnModel {
  return { sessionId, turns: [], entries: {}, validator, more: false };
}

function engineFor(cached: Validator | null) {
  const store = createChatStore();
  const sid = 'br_active';
  if (cached) store.getState().actions.setTurns(sid, modelWith(sid, cached));
  const api = {
    fetchFor: () => vi.fn(),
    basePath: '/api/bridge',
    getValidators: vi.fn(async () => ({})),
    getMessages: vi.fn(async () => ({ model: modelWith(sid, { maxEventId: 0, eventCount: 0, updatedAt: '' }) })),
    getSummary: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    getFolders: vi.fn(async () => []),
  } as unknown as ApiClient;
  const cache = { isEnabled: false, putTurns: vi.fn(async () => {}) } as unknown as SessionCache;
  const engine = new SyncEngine({ store, api, cache });
  return { store, engine, sid };
}

/** The 4th argument of the most recent `connectSessionSSE` call. */
function lastEventIdArgument(): unknown {
  const call = connectSessionSSE.mock.calls.at(-1);
  return call?.[3];
}

let running: { stop: () => void } | null = null;
afterEach(() => {
  running?.stop();
  running = null;
  connectSessionSSE.mockReset();
  connectListSSE.mockReset();
});

describe('the per-session SSE resume point', () => {
  it('sends NO Last-Event-ID for a session with nothing cached', async () => {
    connectSessionSSE.mockImplementation(() => noEvents());
    connectListSSE.mockImplementation(() => noEvents());
    const { store, engine, sid } = engineFor(null);
    running = engine;

    engine.start();
    store.getState().actions.setActive(sid);
    await Promise.resolve();

    expect(connectSessionSSE).toHaveBeenCalled();
    // Not '0', and not '' — absent. `connectSessionSSE` only sets the header
    // when this is truthy, so a falsy-but-present value would work by accident
    // here and stop working the moment that check changed.
    expect(lastEventIdArgument()).toBeUndefined();
  });

  it('resumes from the highest cached event id when there IS one', async () => {
    // The cry-wolf control for the case above: proves the argument is genuinely
    // being read from the cache, not merely absent for every input.
    connectSessionSSE.mockImplementation(() => noEvents());
    connectListSSE.mockImplementation(() => noEvents());
    const { store, engine, sid } = engineFor({ maxEventId: 42, eventCount: 7, updatedAt: '' });
    running = engine;

    engine.start();
    store.getState().actions.setActive(sid);
    await Promise.resolve();

    expect(lastEventIdArgument()).toBe('42');
  });

  it('a cached validator of 0 events is the same as nothing cached', async () => {
    // The boundary between the two cases above, and the one the mutation lands
    // on: a session whose cached tail is empty has `maxEventId` 0, which is a
    // real number and would stringify to "0". Zero events seen is not a resume
    // point.
    connectSessionSSE.mockImplementation(() => noEvents());
    connectListSSE.mockImplementation(() => noEvents());
    const { store, engine, sid } = engineFor({ maxEventId: 0, eventCount: 0, updatedAt: '' });
    running = engine;

    engine.start();
    store.getState().actions.setActive(sid);
    await Promise.resolve();

    expect(lastEventIdArgument()).toBeUndefined();
  });
});
