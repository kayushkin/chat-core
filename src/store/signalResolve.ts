import type { ApiClient } from '../net/ApiClient.js';
import {
  SIGNAL_KIND_NOTIFICATION,
  SIGNAL_STATE_ACKNOWLEDGED,
  SIGNAL_STATE_DISMISSED,
  type Signal,
  type SignalAnswer,
  type SignalRequest,
} from '../net/signals.js';

// The verbs that close a signal. Ported from bridge-ui's `signalData.ts`, which
// is the working v1 of this feature.
//
// They live in `store/` rather than on `ApiClient` because answering a signal is
// ORCHESTRATION, not one request: the tool path reads the parked hook back
// before it writes (see `resolveSignalQuestions`), and the derived path resolves
// through an entirely different endpoint. `ApiClient` stays a thin, honest
// pass-through over each individual route; the decision about which route
// answers which signal is here, once, for every surface that renders a card.

/** Every mounted signal surface reads the same records, so a resolve on one has
 *  to reach the others: answering in a sidebar inbox while a RefChip panel is
 *  open on the same session otherwise leaves the panel offering a question that
 *  is already answered. There is no signal event on the SSE stream yet, so the
 *  verbs below announce it in-process and every subscriber refetches.
 *
 *  This is a refetch trigger, NOT a cache — each surface still asks the server
 *  what is open, so the server stays the single source of truth for state. */
const signalChangeListeners = new Set<() => void>();

/** Be told that a signal was resolved somewhere in this tab. Returns the
 *  unsubscribe function. */
export function subscribeToSignalChanges(listener: () => void): () => void {
  signalChangeListeners.add(listener);
  return () => {
    signalChangeListeners.delete(listener);
  };
}

function announceSignalsChanged(): void {
  for (const listener of signalChangeListeners) listener();
}

/** What goes on the wire for one signal: the picked option's value, or the
 *  typed text. Empty means unanswered.
 *
 *  A signal is answered with an option OR with freeform text, never both —
 *  picking one clears the other in the card, and this is the reader that holds
 *  the same rule for anything composing an answer without the card. */
export function answerTextOf(answer: SignalAnswer | undefined): string {
  return (answer?.option || answer?.text || '').trim();
}

/** The signals in a request that need an ANSWER. Notifications ride in the same
 *  group but are acknowledged one at a time, so they never gate a submit. */
export function questionsIn(request: SignalRequest): Signal[] {
  return request.signals.filter((s) => s.kind !== SIGNAL_KIND_NOTIFICATION);
}

/** Whether the whole request is ready to submit.
 *
 *  One AskUserQuestion call carries several questions and resolves ONCE, so
 *  answering a single question in isolation would resolve the whole request with
 *  the rest unanswered. A surface must keep its submit disabled until this is
 *  true. */
export function everyQuestionAnswered(
  request: SignalRequest,
  answersBySignalId: Readonly<Record<string, SignalAnswer>>,
): boolean {
  const questions = questionsIn(request);
  return (
    questions.length > 0 && questions.every((s) => answerTextOf(answersBySignalId[s.id]) !== '')
  );
}

/**
 * Answer every question in one parked request.
 *
 * `answersByTitle` is keyed by SIGNAL TITLE, which is exactly what the server
 * minted each row's title from and exactly what it reads back to pair an answer
 * with its row (`resolveSignalsForRequest` in llm-bridge-server's
 * `internal/server/signals.go`). Nothing here may key it by signal id.
 *
 * ⚠️ This is TWO steps, and the first one is not optional. The parked hook's own
 * tool input is fetched and passed back untouched UNDER the answers, because the
 * resolve verb REPLACES the tool input wholesale — rebuilding it from the signal
 * rows would silently drop whatever the record does not carry (`multiSelect`,
 * option previews). If the request is no longer parked there is nothing to
 * answer, and that is an error the user sees rather than a resolve posted into
 * the void.
 */
export async function resolveSignalQuestions(
  api: ApiClient,
  sessionId: string,
  requestId: string,
  answersByTitle: Readonly<Record<string, string>>,
): Promise<void> {
  if (!requestId) throw new Error('this signal carries no request_id — nothing to resolve');
  const pending = await api.getPendingHooks(sessionId);
  const hook = pending.find((h) => h.requestId === requestId);
  if (!hook) {
    throw new Error('this question is no longer waiting for an answer — its session moved on');
  }
  const parkedInput = (hook.input ?? {}) as Record<string, unknown>;
  await api.resolveHook(sessionId, {
    requestId,
    behavior: 'allow',
    updatedInput: { ...parkedInput, answers: answersByTitle },
    resolvedBy: 'user',
  });
  announceSignalsChanged();
}

/**
 * Answer a derived question by sending its answer as the session's next user
 * message.
 *
 * Derived signals carry no `request_id` — no hook was ever parked for them — so
 * the hook-resolve verb cannot reach them. Sending a message IS their resolve
 * verb (SESSION-SIGNALS.md, "Resolve — per kind and source").
 *
 * The record closes SERVER-SIDE, in the /send handler, not here: a derived
 * question answered from the CLI or by an orchestrator has to close the same way
 * as one answered from a card, and only the server sees all of them. So this
 * posts the message and nothing else.
 */
export async function answerDerivedQuestion(
  api: ApiClient,
  sessionId: string,
  text: string,
): Promise<void> {
  const message = text.trim();
  if (!message) throw new Error('an answer cannot be empty');
  await api.send(sessionId, message);
  announceSignalsChanged();
}

/**
 * Submit one whole request group, whichever producer minted it.
 *
 * This is the single place that decides which verb answers which signal, so a
 * host rendering its own answer UI branches the same way the shipped card does.
 * `answersBySignalId` is keyed by signal id (what a form holds); the title
 * keying the server needs is derived here, from the group.
 */
export async function answerSignalRequest(
  api: ApiClient,
  request: SignalRequest,
  answersBySignalId: Readonly<Record<string, SignalAnswer>>,
): Promise<void> {
  const questions = questionsIn(request);
  if (questions.length === 0) throw new Error('this request has no question to answer');
  if (!everyQuestionAnswered(request, answersBySignalId)) {
    // The whole request resolves at once, so a partial submit would answer some
    // questions and silently discard the rest.
    throw new Error('every question in this request has to be answered before it can be submitted');
  }
  if (request.requestId) {
    const answersByTitle: Record<string, string> = {};
    for (const signal of questions) {
      answersByTitle[signal.title] = answerTextOf(answersBySignalId[signal.id]);
    }
    await resolveSignalQuestions(api, request.sessionId, request.requestId, answersByTitle);
    return;
  }
  // A derived question has no parked hook, so it resolves by becoming the
  // session's next user message. Grouping puts exactly one derived signal in a
  // group, so there is one answer to send.
  const only = questions[0] as Signal;
  await answerDerivedQuestion(api, request.sessionId, answerTextOf(answersBySignalId[only.id]));
}

/**
 * Decline every question in one parked request.
 *
 * Unlike answering, this needs no parked input: a deny carries no
 * `updated_input`, and bridge-server records the decision (and closes the signal
 * rows) even for a request whose park is already gone. Only offered where there
 * IS a request id — a derived question parked nothing, so there is nothing to
 * deny.
 */
export async function declineSignalQuestions(
  api: ApiClient,
  sessionId: string,
  requestId: string,
): Promise<void> {
  if (!requestId) throw new Error('this signal carries no request_id — nothing to decline');
  await api.resolveHook(sessionId, { requestId, behavior: 'deny', resolvedBy: 'user' });
  announceSignalsChanged();
}

/**
 * Acknowledge a notification: close it without answering anything.
 *
 * Notifications are the one signal kind with no answer to deliver, so they have
 * no producer-specific resolve path — a tool notification and a derived one both
 * close here, through the signal-level verb (POST /signals/{id}/resolve).
 *
 * The server refuses this for a QUESTION on purpose: a question nobody answered
 * has not been handled, and grading it "seen" would read as handled on the
 * surface that matters most, a worker's kanban card. Dismiss it instead.
 */
export async function acknowledgeSignal(api: ApiClient, signalId: string): Promise<void> {
  await api.resolveSignal(signalId, SIGNAL_STATE_ACKNOWLEDGED);
  announceSignalsChanged();
}

/**
 * Close a signal without an answer. Says out loud that no answer is coming,
 * which is the honest close for a question the user will not take — and, for a
 * derived question, what walks its session back off `awaiting_user`.
 */
export async function dismissSignal(api: ApiClient, signalId: string): Promise<void> {
  await api.resolveSignal(signalId, SIGNAL_STATE_DISMISSED);
  announceSignalsChanged();
}
