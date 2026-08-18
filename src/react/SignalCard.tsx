import { useCallback, useState, type JSX, type ReactNode } from 'react';
import { useChatContext } from './context.js';
import {
  SIGNAL_KIND_NOTIFICATION,
  SIGNAL_SEVERITY_WARN,
  type Signal,
  type SignalAnswer,
  type SignalRequest,
} from '../net/signals.js';
import {
  acknowledgeSignal,
  answerSignalRequest,
  declineSignalQuestions,
  dismissSignal,
  everyQuestionAnswered,
  questionsIn,
} from '../store/signalResolve.js';

// Ported from bridge-ui's `SignalCard.tsx`. Theming stays at the edge, exactly
// as in `RefChip.tsx`: every element carries a stable, unhashed class name
// (`signal-*`) and this file ships NO CSS — the host styles it. The prefix is
// `signal-` rather than `ref-chip-` because these cards are not a chip's
// property; the RefChip panel is one of four surfaces they render on, and the
// mount point inside it is what carries the `ref-chip-*` name.

export interface SignalCardProps {
  signal: Signal;
  /** The answer being composed for this signal. A signal is answered with an
   *  option or with freeform text, NEVER both — picking one clears the other. */
  answer?: SignalAnswer;
  onChangeAnswer?: (answer: SignalAnswer) => void;
  /** Acknowledge a notification. Left optional because a surface that cannot
   *  refetch afterwards is better off not offering the button at all — the card
   *  renders no action rather than one that leaves a resolved row on screen. */
  onAcknowledge?: () => void;
  busy?: boolean;
  /** Drops descriptions and the body for tight surfaces (the RefChip session
   *  panel). The question, its options and its freeform box all still render:
   *  compact trims chrome, never the means of answering. */
  compact?: boolean;
}

/**
 * SignalCard renders exactly one signal record, by kind. It takes EVERYTHING
 * through props and reads no context at all, so the same card renders in the
 * raising session's chat, in a cross-session inbox, and inside another session's
 * RefChip panel.
 *
 * It composes an answer but never submits one: a tool question is one of several
 * sharing a parked request, and that whole request resolves at once.
 * {@link SignalRequestCard} below owns the submit.
 */
export function SignalCard({
  signal,
  answer,
  onChangeAnswer,
  onAcknowledge,
  busy,
  compact,
}: SignalCardProps): JSX.Element {
  const isNotification = signal.kind === SIGNAL_KIND_NOTIFICATION;
  const options = signal.options;
  const chosen = answer?.option ?? '';
  const text = answer?.text ?? '';

  return (
    <div className={`signal-card${compact ? ' signal-card-compact' : ''}`} data-signal-id={signal.id}>
      <div className="signal-card-header">
        <span className={`signal-kind signal-kind-${isNotification ? 'notification' : 'question'}`}>
          {isNotification ? 'notification' : 'question'}
        </span>
        {isNotification && signal.severity === SIGNAL_SEVERITY_WARN && (
          <span className="signal-severity">warn</span>
        )}
      </div>

      <p className="signal-title">{signal.title}</p>
      {signal.body !== '' && !compact && <p className="signal-body">{signal.body}</p>}

      {!isNotification && options.length > 0 && (
        <div className="signal-options">
          {options.map((option) => {
            // `value` is what the resolve verb sends back; producers with no
            // separate machine value set it to the label, so the label is the
            // fallback rather than an invention.
            const value = option.value || option.label;
            return (
              <label
                key={value}
                className={`signal-option${chosen === value ? ' signal-option-selected' : ''}`}
              >
                <input
                  type="radio"
                  name={`signal-${signal.id}`}
                  checked={chosen === value}
                  disabled={busy || !onChangeAnswer}
                  // An option and freeform text are exclusive: this replaces the
                  // composed answer rather than merging into it.
                  onChange={() => onChangeAnswer?.({ option: value })}
                />
                <span className="signal-option-body">
                  <span className="signal-option-label">{option.label}</span>
                  {option.description !== '' && !compact && (
                    <span className="signal-option-desc">{option.description}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {/* Every question gets a freeform box, unconditionally.
          NOT gated on `compact`: that hid the only way to answer a question the
          producer minted with no options, and trimming chrome must never remove
          the means of answering.
          NOT gated on `signal.allowFreeform` either. Nothing sets that field
          false — both producers hardcode it true (`signal_classifier.go:504`,
          `signals.go:115`) and the server has no path that rejects a freeform
          answer. What it does have is `signalFromWire` defaulting it to FALSE
          when the key is absent, so an older row or a producer that omits it
          loses its answer box with no way to tell. A display hint that is never
          deliberately false, and fails closed onto an unanswerable card, is not
          worth honouring. The field stays parsed — it is the wire's, and this
          layer passes it through — it simply no longer decides this. */}
      {!isNotification && (
        <textarea
          className="signal-freeform"
          placeholder={options.length > 0 ? '…or answer in your own words' : 'Type your answer'}
          value={text}
          disabled={busy || !onChangeAnswer}
          onChange={(e) => onChangeAnswer?.({ text: e.target.value })}
          rows={2}
        />
      )}

      {isNotification && onAcknowledge && (
        <div className="signal-actions">
          <button type="button" className="signal-ack" disabled={busy} onClick={onAcknowledge}>
            Acknowledge
          </button>
        </div>
      )}
    </div>
  );
}

export interface SignalRequestCardProps {
  request: SignalRequest;
  /** Called after a successful resolve so the surface can refetch. */
  onResolved?: () => void;
  /** Rendered above the questions — a cross-session inbox uses it for a link to
   *  the raising session; the in-session surfaces pass nothing. */
  header?: ReactNode;
  compact?: boolean;
  /** Offer to close a question nobody is going to answer.
   *
   *  Only meaningful for a DERIVED question: a parked tool question already has
   *  Decline, which denies the call the question came from, and that is the
   *  honest close there. A derived question parked nothing, so without this it
   *  stays open until the session's next turn happens to supersede it — which,
   *  on a card raised by a worker that has since stopped, is never.
   *
   *  Off by default, so a chat surface keeps answering as its only close. */
  allowDismissWithoutAnswer?: boolean;
}

/**
 * SignalRequestCard renders every signal minted by one parked request and
 * submits their answers TOGETHER.
 *
 * One AskUserQuestion call carries several questions and resolves once, so
 * answering a single question in isolation would resolve the whole request with
 * the rest unanswered. Submit stays disabled until every question in the request
 * has an answer.
 *
 * ⚠️ The only thing this reads from context is the `ApiClient` singleton — never
 * the active session. Which session it is answering comes from `request`, and
 * that is precisely why it can be mounted inside another session's RefChip panel
 * and answer a question the user is not looking at.
 */
export function SignalRequestCard({
  request,
  onResolved,
  header,
  compact,
  allowDismissWithoutAnswer,
}: SignalRequestCardProps): JSX.Element {
  const { api } = useChatContext();
  const [answers, setAnswers] = useState<Record<string, SignalAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const questions = questionsIn(request);
  const allAnswered = everyQuestionAnswered(request, answers);

  const setAnswer = useCallback((signalId: string, answer: SignalAnswer) => {
    setAnswers((prev) => ({ ...prev, [signalId]: answer }));
  }, []);

  /** Every action here is the same three steps around a different verb: hold the
   *  card busy, surface any refusal in place, and let the surface refetch on
   *  success. A failed resolve must leave the card on screen — the question is
   *  still open and the only way out is another click. */
  const run = useCallback(
    async (verb: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await verb();
        onResolved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, onResolved],
  );

  const submit = useCallback(() => {
    if (!allAnswered) return;
    // One verb for both producers: it sends a tool request's answers back through
    // its parked hook, and a derived question's answer as the session's next
    // message. The branch lives in the store, not in this card.
    void run(() => answerSignalRequest(api, request, answers));
  }, [allAnswered, run, api, request, answers]);

  const acknowledge = useCallback(
    (signalId: string) => {
      void run(() => acknowledgeSignal(api, signalId));
    },
    [run, api],
  );

  const dismiss = useCallback(() => {
    // A group of derived signals holds exactly one row today, but closing every
    // question in the group is what "dismiss this" means either way — leaving a
    // sibling open would be a half-closed request.
    void run(async () => {
      for (const signal of questions) await dismissSignal(api, signal.id);
    });
  }, [run, api, questions]);

  const decline = useCallback(() => {
    void run(() => declineSignalQuestions(api, request.sessionId, request.requestId));
  }, [run, api, request]);

  return (
    <div className="signal-request" data-session-id={request.sessionId} data-request-id={request.requestId}>
      {header}
      {request.signals.map((signal) => (
        <SignalCard
          key={signal.id}
          signal={signal}
          answer={answers[signal.id]}
          // Notifications are acknowledged, not answered — they compose nothing
          // on either producer's path, and close one at a time through the
          // signal-level verb rather than with the group.
          onChangeAnswer={
            signal.kind === SIGNAL_KIND_NOTIFICATION ? undefined : (a) => setAnswer(signal.id, a)
          }
          onAcknowledge={
            signal.kind === SIGNAL_KIND_NOTIFICATION ? () => acknowledge(signal.id) : undefined
          }
          busy={busy}
          compact={compact}
        />
      ))}
      {questions.length > 0 && (
        <div className="signal-actions">
          <button
            type="button"
            className="signal-submit"
            disabled={busy || !allAnswered}
            onClick={submit}
          >
            {request.requestId ? 'Submit' : 'Send answer'}
          </button>
          {/* Declining means denying a parked tool call. A derived question parked
              nothing, so there is nothing to deny — it simply stays open until
              the session's next turn supersedes it. */}
          {request.requestId !== '' && (
            <button type="button" className="signal-decline" disabled={busy} onClick={decline}>
              Decline
            </button>
          )}
          {/* Dismiss is the derived half of the same act: it says out loud that no
              answer is coming, which is the only thing that closes a derived
              question short of answering it. */}
          {request.requestId === '' && allowDismissWithoutAnswer && (
            <button type="button" className="signal-dismiss" disabled={busy} onClick={dismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {error !== null && <p className="signal-error">{error}</p>}
    </div>
  );
}
