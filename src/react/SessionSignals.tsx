import type { JSX } from 'react';
import { SignalRequestCard } from './SignalCard.js';
import { useOpenSignals } from './signals.js';
import { groupSignalsByRequest, type SignalRequest } from '../net/signals.js';

export interface SessionSignalsProps {
  sessionId: string;
  /** `requestId`s the surrounding surface is already rendering itself. The
   *  raising session's own chat passes its parked hooks: a permissions banner
   *  renders those from the LIVE tool input, with the multi-select and option
   *  previews the signal record does not carry, so showing a signal card for the
   *  same question underneath it would be the same question twice. What is left
   *  is what the banner cannot show — signals whose park has gone (a harness
   *  restart), and derived ones. */
  excludeRequestIds?: readonly string[];
  compact?: boolean;
  /** Heading above the cards. Omit for surfaces tight enough that the card's own
   *  "question"/"notification" label is heading enough. */
  title?: string;
}

/**
 * SessionSignals is the open chat signals raised by ONE session, answerable in
 * place. Renders nothing when the session has none, when the surrounding surface
 * already renders all of them, or when this bridge-server has no signals route.
 *
 * Ported from bridge-ui's `SessionSignals.tsx`.
 */
export function SessionSignals({
  sessionId,
  excludeRequestIds,
  compact,
  title,
}: SessionSignalsProps): JSX.Element | null {
  const { signals, error, reload } = useOpenSignals(sessionId);

  const excluded = excludeRequestIds ?? [];
  // A derived signal has no request id and can never be the banner's; only a
  // tool signal is ever excluded.
  const shown = signals.filter((s) => s.requestId === '' || !excluded.includes(s.requestId));

  if (error !== null) return <p className="signal-error">Couldn’t load signals: {error}</p>;

  // Grouped from what is actually on screen rather than from the hook's own
  // `requests`, because the exclusion above changes which signals those are.
  return (
    <SignalRequestList
      requests={groupSignalsByRequest(shown)}
      compact={compact}
      title={title}
      onResolved={reload}
    />
  );
}

export interface SignalRequestListProps {
  requests: readonly SignalRequest[];
  compact?: boolean;
  title?: string;
  onResolved?: () => void;
  /** Passed through to every card — see `SignalRequestCard`. */
  allowDismissWithoutAnswer?: boolean;
}

/**
 * The rendered list of request groups, with no fetching of its own.
 *
 * Split out from {@link SessionSignals} so a host with its own source of signals
 * — a cross-session "Needs you" inbox, a kanban card drawer — renders the same
 * cards without going through the per-session read. It also makes the empty case
 * assertable: a bridge-server with no signals route yields zero requests, and
 * this renders nothing at all rather than an empty box or an error.
 */
export function SignalRequestList({
  requests,
  compact,
  title,
  onResolved,
  allowDismissWithoutAnswer,
}: SignalRequestListProps): JSX.Element | null {
  if (requests.length === 0) return null;
  return (
    <div className="signals" role="region" aria-label="Session signals">
      {title !== undefined && title !== '' && <div className="signals-title">{title}</div>}
      {requests.map((request) => (
        <SignalRequestCard
          // A derived group has no request id, so it is keyed by its one
          // signal's id — never by the empty string, which every derived group
          // would share.
          key={request.requestId || request.signals[0]?.id}
          request={request}
          compact={compact}
          onResolved={onResolved}
          allowDismissWithoutAnswer={allowDismissWithoutAnswer}
        />
      ))}
    </div>
  );
}
