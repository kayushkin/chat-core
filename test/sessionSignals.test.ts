import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/net/ApiClient.js';
import {
  groupSignalsByRequest,
  signalFromWire,
  type Signal,
  type SignalWire,
} from '../src/net/signals.js';
import {
  acknowledgeSignal,
  answerSignalRequest,
  dismissSignal,
  everyQuestionAnswered,
  resolveSignalQuestions,
  subscribeToSignalChanges,
} from '../src/store/signalResolve.js';
import { SignalCard } from '../src/react/SignalCard.js';
import { SignalRequestList } from '../src/react/SessionSignals.js';

// Answering a session signal is the one place in this package where a write is
// preceded by a mandatory read, and the reason is invisible from the request
// itself: the hook-resolve verb REPLACES the parked tool input wholesale, so
// anything the signal record does not carry (multiSelect, option previews) is
// destroyed unless the parked input is fetched back and merged under the
// answers. Every case here exists because getting one of these wrong produces a
// resolve the server accepts and a question the user answered wrongly, silently.

const BASE = '/api/bridge';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A `Response`-shaped object. Only the four members `ApiClient` touches. */
function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** A fetch that routes on the URL and records every call, so a test can assert
 *  BOTH what went on the wire and what did NOT (a decline must never fetch the
 *  pending hooks; a derived answer must never touch the resolve route). */
function recordingFetch(
  route: (url: string) => Response | undefined,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const res = route(String(url));
    if (!res) throw new Error(`no route for ${method} ${String(url)}`);
    return res;
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

function client(route: (url: string) => Response | undefined): { api: ApiClient; calls: Call[] } {
  const { fetch, calls } = recordingFetch(route);
  return { api: new ApiClient({ fetch, basePath: BASE }), calls };
}

function question(overrides: Partial<SignalWire>): Signal {
  return signalFromWire({
    id: 'sig-1',
    session_id: 'br_a',
    kind: 'question',
    source: 'tool',
    surface: 'chat',
    title: 'Which database?',
    state: 'open',
    created_at: '2026-08-17T10:00:00Z',
    ...overrides,
  });
}

/** The parked AskUserQuestion input, as the harness left it. `multiSelect` and
 *  the option `description`s are the fields the signal record does NOT carry —
 *  they are why the pending-hook refetch is mandatory. */
const PARKED_INPUT = {
  questions: [
    {
      question: 'Which database?',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'the one already deployed' },
        { label: 'SQLite', description: 'file-local' },
      ],
    },
    { question: 'Ship it today?', multiSelect: true, options: [{ label: 'yes' }, { label: 'no' }] },
  ],
};

function pendingHooksBody(requestId: string): Array<{ hook: Record<string, unknown> }> {
  // The endpoint answers with whole `msg.Event`s, so the hook rides under
  // `.hook` — that is what `handleListPendingHooks` writes, and what
  // `ApiClient.getPendingHooks` unwraps.
  return [
    {
      hook: {
        request_id: requestId,
        event: 'PreToolUse',
        phase: 'awaiting_resolution',
        source: 'user_input',
        tool_name: 'AskUserQuestion',
        input: PARKED_INPUT,
      },
    },
  ];
}

describe('answering goes through one door, whatever raised the question', () => {
  // The client used to choose the transport. It read requestId, then either
  // re-fetched the parked hook, merged answers under its tool input and posted
  // that to the hook route, or posted text to /send. Both were decisions made
  // on evidence the client did not have: a requestId says a park EXISTED, not
  // that it is still live. The server decides now, and these pin that the
  // client stopped trying to.
  const answerRoute = (url: string): Response | undefined =>
    url.includes('/answer') ? new Response('{}', { status: 200 }) : undefined;

  it('posts a parked question to /answer and nowhere else', async () => {
    const { api, calls } = client(answerRoute);
    const request = groupSignalsByRequest([
      question({ id: 'sig-1', request_id: 'req-7', title: 'Ship it?' }),
      question({ id: 'sig-2', request_id: 'req-7', title: 'Which branch?' }),
    ])[0] as SignalRequest;

    await answerSignalRequest(api, request, {
      'sig-1': { text: 'Yes' },
      'sig-2': { option: 'main' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/signals/sig-1/answer');
    // Keyed by SIGNAL ID. The title-keyed pairing the parked hook needs is
    // derived server-side now, beside the parked input it merges into — the
    // client no longer knows that pairing exists.
    expect(calls[0]?.body).toEqual({ answers: { 'sig-1': 'Yes', 'sig-2': 'main' } });
    // Specifically NOT the two calls the old path made.
    expect(calls.some((c) => c.url.includes('/hooks/'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false);
  });

  it('posts a derived question to the same route, with the same shape', async () => {
    const { api, calls } = client(answerRoute);
    const request = groupSignalsByRequest([
      question({ id: 'sig-9', request_id: '', title: 'Which transport?' }),
    ])[0] as SignalRequest;

    await answerSignalRequest(api, request, { 'sig-9': { text: 'codex' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/signals/sig-9/answer');
    expect(calls[0]?.body).toEqual({ answers: { 'sig-9': 'codex' } });
  });

  it('refuses a partial answer before spending a round trip', async () => {
    // The server enforces this too, and its copy is the one that counts. This
    // one only saves a request, so it must not be the only guard — but it must
    // also not send.
    const { api, calls } = client(answerRoute);
    const request = groupSignalsByRequest([
      question({ id: 'sig-1', request_id: 'req-7', title: 'Ship it?' }),
      question({ id: 'sig-2', request_id: 'req-7', title: 'Which branch?' }),
    ])[0] as SignalRequest;

    await expect(answerSignalRequest(api, request, { 'sig-1': { text: 'Yes' } })).rejects.toThrow(
      /every question/i,
    );
    expect(calls).toHaveLength(0);
  });

  it('surfaces a server refusal instead of swallowing it', async () => {
    const { api } = client((url) =>
      url.includes('/answer')
        ? new Response('{"error":{"code":"already_resolved"}}', { status: 409 })
        : undefined,
    );
    const request = groupSignalsByRequest([
      question({ id: 'sig-9', request_id: '', title: 'Which transport?' }),
    ])[0] as SignalRequest;

    await expect(answerSignalRequest(api, request, { 'sig-9': { text: 'codex' } })).rejects.toThrow();
  });
});


describe('declining a parked request', () => {

});

describe('the signal-level verbs (acknowledge / dismiss)', () => {
  it('POST /signals/{id}/resolve with the state', async () => {
    const { api, calls } = client((url) => (url.includes('/signals/') ? respond(200, {}) : undefined));

    await acknowledgeSignal(api, 'sig-note');
    await dismissSignal(api, 'sig-1');

    expect(calls[0]!.url).toBe(`${BASE}/signals/sig-note/resolve`);
    expect(calls[0]!.body).toEqual({ state: 'acknowledged' });
    expect(calls[1]!.url).toBe(`${BASE}/signals/sig-1/resolve`);
    expect(calls[1]!.body).toEqual({ state: 'dismissed' });
  });

  it('surfaces the server refusing to acknowledge a question, rather than swallowing it', async () => {
    // The server refuses `acknowledged` for a question ON PURPOSE: a question
    // nobody answered has not been handled, and grading it "seen" would read as
    // handled on a worker's kanban card. This reaches the client only from a
    // click, so it must be reported — a button that silently does nothing is
    // worse than an error.
    const { api } = client(() => respond(400, 'a question cannot be acknowledged'));
    await expect(acknowledgeSignal(api, 'sig-1')).rejects.toThrow(/400/);
  });
});

describe('a resolve on one surface reaches the others', () => {
});

describe('the whole request resolves at once', () => {
  it('is not submittable until every question in the group is answered', async () => {
    const first = question({ id: 'sig-1', request_id: 'req-7', title: 'Which database?' });
    const second = question({ id: 'sig-2', request_id: 'req-7', title: 'Ship it today?' });
    const notification = question({
      id: 'sig-3',
      request_id: 'req-7',
      kind: 'notification',
      title: 'the build finished',
    });
    const [request] = groupSignalsByRequest([first, second, notification]);

    expect(everyQuestionAnswered(request!, {})).toBe(false);
    expect(everyQuestionAnswered(request!, { 'sig-1': { option: 'Postgres' } })).toBe(false);
    // A notification rides in the group but is acknowledged separately, so it
    // must never gate the submit.
    expect(
      everyQuestionAnswered(request!, {
        'sig-1': { option: 'Postgres' },
        'sig-2': { text: 'no' },
      }),
    ).toBe(true);

    // And the verb enforces it too, so a surface that gets its own disabled
    // state wrong still cannot resolve a request with unanswered questions.
    const { api, calls } = client(() => respond(200, {}));
    await expect(
      answerSignalRequest(api, request!, { 'sig-1': { option: 'Postgres' } }),
    ).rejects.toThrow(/every question/);
    expect(calls).toEqual([]);
  });

  it('groups by request_id, and keeps two sessions apart', () => {
    const a1 = question({ id: 's1', session_id: 'br_a', request_id: 'req-1' });
    const a2 = question({ id: 's2', session_id: 'br_a', request_id: 'req-1' });
    const b1 = question({ id: 's3', session_id: 'br_b', request_id: 'req-1' });
    const derivedOne = question({ id: 's4', session_id: 'br_a', source: 'derived' });
    const derivedTwo = question({ id: 's5', session_id: 'br_a', source: 'derived' });

    const groups = groupSignalsByRequest([a1, a2, b1, derivedOne, derivedTwo]);
    // Same request id in two sessions is two requests, never one.
    expect(groups.map((g) => [g.sessionId, g.requestId, g.signals.length])).toEqual([
      ['br_a', 'req-1', 2],
      ['br_b', 'req-1', 1],
      // Each derived signal gets its own group — they share the empty request id
      // and must not collapse into one.
      ['br_a', '', 1],
      ['br_a', '', 1],
    ]);
  });
});

describe('a bridge-server with no signals route', () => {
  it('answers null from the read instead of throwing', async () => {
    const { api } = client(() => respond(404, 'not found'));
    // null, not [] and not an error: a server without the feature is not a
    // failure to show the user, and an empty list would say "deployed and
    // quiet", which is a different fact.
    await expect(api.getOpenChatSignals({ sessionId: 'br_a' })).resolves.toBeNull();
  });

  it('still throws on a real failure — 404 is the ONLY swallowed status', async () => {
    const { api } = client(() => respond(500, 'boom'));
    await expect(api.getOpenChatSignals()).rejects.toThrow(/500/);
  });

  it('renders nothing at all, rather than an empty box or an error', () => {
    // What the 404 leaves the surface holding: no signals, therefore no request
    // groups. `SignalRequestList` is the whole render path below `SessionSignals`
    // — asserting on it is what makes the empty case checkable without a DOM.
    const groups = groupSignalsByRequest([]);
    expect(renderToStaticMarkup(createElement(SignalRequestList, { requests: groups }))).toBe('');
  });

  it('asks the cross-session route, scoped by session_id', async () => {
    const { api, calls } = client(() => respond(200, []));
    await api.getOpenChatSignals({ sessionId: 'br_a' });
    // The per-session route answers 404 for both "no signals route" and "no such
    // session"; this one only 404s for the first, so the answer is unambiguous.
    expect(calls[0]!.url).toBe(`${BASE}/signals?state=open&surface=chat&session_id=br_a`);
  });
});

describe('SignalCard reads no context', () => {
  it('renders a question with its options outside any provider', () => {
    const signal = question({
      id: 'sig-1',
      request_id: 'req-7',
      title: 'Which database?',
      options: [
        { label: 'Postgres', value: 'pg', description: 'already deployed' },
        { label: 'SQLite', value: '' },
      ],
    });
    // No ChatProvider anywhere. That is the point: the same card renders in the
    // raising session's chat, in a cross-session inbox, and inside ANOTHER
    // session's RefChip panel, because it never asks which session is active.
    const html = renderToStaticMarkup(
      createElement(SignalCard, { signal, answer: { option: 'pg' } }),
    );
    expect(html).toContain('Which database?');
    expect(html).toContain('Postgres');
    expect(html).toContain('already deployed');
    expect(html).toContain('signal-option-selected');
  });

  it('drops descriptions when compact, and still renders the options', () => {
    const signal = question({
      id: 'sig-1',
      request_id: 'req-7',
      allow_freeform: true,
      options: [{ label: 'Postgres', value: 'pg', description: 'already deployed' }],
    });
    const html = renderToStaticMarkup(createElement(SignalCard, { signal, compact: true }));
    // A compact card is still answerable — the question and its options stay.
    expect(html).toContain('Postgres');
    expect(html).not.toContain('already deployed');
    // Compact trims chrome, never the means of answering: the box stays.
    expect(html).toContain('textarea');
  });

  it('keeps the freeform box when compact and the question has no options', () => {
    // Both server producers mint exactly this: signal_classifier.go sets
    // AllowFreeform with options empty unless the assistant enumerated choices,
    // and signals.go copies a possibly-empty question.Options. dashv2's only
    // signals surface renders compact, so suppressing the box here left such a
    // question with no radios, no textarea, and a Submit that
    // `everyQuestionAnswered` disables forever — unanswerable anywhere.
    const signal = question({
      id: 'sig-1',
      request_id: 'req-7',
      allow_freeform: true,
      options: [],
    });
    const html = renderToStaticMarkup(createElement(SignalCard, { signal, compact: true }));
    expect(html).toContain('textarea');
    expect(html).toContain('Type your answer');
  });

  it('gives a question a freeform box even when allow_freeform is absent from the wire', () => {
    // signalFromWire defaults the flag to FALSE when the key is missing, so
    // honouring it meant an older row — or any producer that omits it — rendered
    // a question nobody could answer. Nothing sets it false on purpose: both
    // producers hardcode it true and the server never rejects a freeform answer.
    const signal = signalFromWire({
      id: 'sig-2',
      session_id: 'sess-1',
      kind: 'question',
      surface: 'chat',
      title: 'Which classifier transport?',
      state: 'open',
    } as SignalWire);
    expect(signal.allowFreeform).toBe(false);
    const html = renderToStaticMarkup(createElement(SignalCard, { signal }));
    expect(html).toContain('textarea');
  });

  it('never gives a notification a freeform box — it is acknowledged, not answered', () => {
    const signal = signalFromWire({
      id: 'sig-3',
      session_id: 'sess-1',
      kind: 'notification',
      surface: 'chat',
      title: 'Deploy finished',
      state: 'open',
    } as SignalWire);
    const html = renderToStaticMarkup(createElement(SignalCard, { signal }));
    expect(html).not.toContain('textarea');
  });
});
