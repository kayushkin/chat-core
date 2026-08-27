import { afterEach, describe, expect, it, vi } from 'vitest';

// The server replays the ENTIRE current turn to a client that connects without a
// `Last-Event-ID`, because it has no way to know what that client already holds.
// Measured 2026-08-26 on three real sessions: 88, 177 and 360 frames, up to 1,154 KB —
// every byte of it content the page had delivered milliseconds earlier. Handed a resume
// point, the same connects replay 0 frames and 0 bytes.
//
// The page now carries that resume point (`MessagesResponse.stream.head`) and the client
// records it — but ⛔ DOES NOT SEND IT. Sending it doubled narration in the UI and was
// withdrawn on 2026-08-27, the day it shipped; `SyncEngine.streamCursors` carries the
// full account of why and what a second attempt has to fix first.
//
// So these cases pin the client half AS IT STANDS: the resume point is recorded, it is
// forgotten when the transcript is evicted, it is not sent, and — the one that outlives
// the withdrawal because it would silently lose transcript — it is never confused with
// the log-store id space.

const connectSessionSSE = vi.fn();
const connectListSSE = vi.fn();

vi.mock('../src/sync/sse.js', () => ({
  connectSessionSSE: (...args: unknown[]) => connectSessionSSE(...args),
  connectListSSE: (...args: unknown[]) => connectListSSE(...args),
}));

const { SyncEngine } = await import('../src/sync/SyncEngine.js');
const { createChatStore } = await import('../src/store/ChatStore.js');
type TurnModel = import('../src/net/types.js').TurnModel;
type ApiClient = import('../src/net/ApiClient.js').ApiClient;
type SessionCache = import('../src/cache/SessionCache.js').SessionCache;

const SID = 'br_active';

/** A model whose LOG-STORE ids are deliberately huge, so a resume point taken from the
 *  wrong id space is unmistakable in an assertion. */
function model(maxEventId: number): TurnModel {
  return {
    sessionId: SID,
    turns: [],
    entries: {},
    validator: { maxEventId, eventCount: maxEventId, updatedAt: '2026-08-26T00:00:00Z' },
    more: false,
  };
}

async function* noEvents(): AsyncGenerator<never> {
  return;
}

function engine() {
  const store = createChatStore();
  const api = {
    fetchFor: () => vi.fn(),
    basePath: '/api/bridge',
    getValidators: vi.fn(async () => ({})),
    getMessages: vi.fn(async () => ({ model: model(0) })),
    listFolders: vi.fn(async () => []),
  } as unknown as ApiClient;
  const cache = {
    isEnabled: false,
    putTurns: vi.fn(async () => {}),
    scheduleTurnsWrite: vi.fn(),
    flushTurnsWrites: vi.fn(async () => {}),
  } as unknown as SessionCache;
  return { store, engine: new SyncEngine({ store, api, cache }) };
}

/** The `Last-Event-ID` the stream was opened with (4th argument). */
function resumePointSent(): unknown {
  return connectSessionSSE.mock.calls.at(-1)?.[3];
}

let running: { stop: () => void } | null = null;
afterEach(() => {
  running?.stop();
  running = null;
  connectSessionSSE.mockReset();
  connectListSSE.mockReset();
});

describe('the page tells the stream where to resume', () => {
  it('records the resume point the page reported', () => {
    const store = createChatStore();
    store.getState().actions.setTurns(SID, model(2094222), { streamHead: 17 });

    expect(store.getState().streamResumeBySession.get(SID)).toBe(17);
  });

  it('records nothing when the server sent no resume point', () => {
    // An older llm-bridge-server. Absent must stay absent — inventing a 0 would tell the
    // stream to resume after row 0, which replays the session from its start.
    const store = createChatStore();
    store.getState().actions.setTurns(SID, model(500));

    expect(store.getState().streamResumeBySession.has(SID)).toBe(false);
  });

  it('does NOT yet open the stream with it — see the withdrawal note', async () => {
    // ⛔ The resume point is recorded but deliberately not sent. Sending it doubled
    // narration in the UI: the page can contain events ABOVE the head (written while the
    // server flushed), the stream re-delivers those, and page-vs-live entries never
    // collide by id — overlap is reconciled by CONTENT in `mergeMaterializedPage`, which
    // only runs when a page lands OVER a live tail. Resuming from a page inverts that
    // order. `SyncEngine.streamCursors` carries the full account.
    //
    // This case exists so re-enabling it is a deliberate act with a red test to answer,
    // rather than something that slips back in because the plumbing was all still there.
    connectSessionSSE.mockImplementation(() => noEvents());
    connectListSSE.mockImplementation(() => noEvents());
    const { store, engine: e } = engine();
    store.getState().actions.setTurns(SID, model(2094222), { streamHead: 4242 });
    store.getState().actions.setActive(SID);

    running = e;
    e.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(resumePointSent()).toBeUndefined();
  });

  it('NEVER sends the log-store id, whatever it does send', async () => {
    // The failure this codebase has already paid for, and it outlives the withdrawal
    // above: `validator.maxEventId` is a log-store row id and the server parses
    // `Last-Event-ID` in its own space. Sending the log-store number — numerically far
    // ahead — made the server replay nothing, so every reconnect silently missed the
    // events between the page and the stream. Whatever this function returns, it must
    // never be that number.
    connectSessionSSE.mockImplementation(() => noEvents());
    connectListSSE.mockImplementation(() => noEvents());
    const { store, engine: e } = engine();
    store.getState().actions.setTurns(SID, model(2094222), { streamHead: 17 });
    store.getState().actions.setActive(SID);

    running = e;
    e.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(resumePointSent()).not.toBe('2094222');
  });

  it('sends nothing for a head of 0 — a session with no stored events needs everything', async () => {
    // Still true whenever the resume point is wired back up: `Last-Event-ID: 0` asks the
    // server to resume AFTER row 0, which is a different request from asking for the
    // stream from its start.
    connectSessionSSE.mockImplementation(() => noEvents());
    connectListSSE.mockImplementation(() => noEvents());
    const { store, engine: e } = engine();
    store.getState().actions.setTurns(SID, model(0), { streamHead: 0 });
    store.getState().actions.setActive(SID);

    running = e;
    e.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(resumePointSent()).toBeUndefined();
  });

  it('forgets the resume point when the transcript is evicted', () => {
    // It describes a page that is no longer held. Left behind, a reopened session would
    // resume from a point its refetched page may not cover.
    const store = createChatStore({ turnRetentionBytes: 1, turnRetentionMinSessions: 1 });
    const { actions } = store.getState();
    const heavy = (id: string): TurnModel => ({
      sessionId: id,
      turns: [],
      entries: {
        [`${id}-e`]: {
          id: `${id}-e`,
          turnId: 't',
          role: 'user',
          kind: 'text',
          source: 'harness',
          eventId: 1,
          ts: '2026-08-26T00:00:00Z',
          text: 'x'.repeat(50_000),
          duplicate: false,
          primary: true,
        },
      },
      validator: { maxEventId: 1, eventCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
      more: false,
    });

    actions.setActive('br_old');
    actions.setTurns('br_old', heavy('br_old'), { streamHead: 99 });
    expect(store.getState().streamResumeBySession.get('br_old')).toBe(99);

    for (let n = 0; n < 4; n++) {
      actions.setActive(`br_new_${n}`);
      actions.setTurns(`br_new_${n}`, heavy(`br_new_${n}`), { streamHead: 100 + n });
    }

    expect(store.getState().turnsBySession.has('br_old')).toBe(false);
    expect(store.getState().streamResumeBySession.has('br_old')).toBe(false);
  });
});
