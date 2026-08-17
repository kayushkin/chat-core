import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatContext } from './context.js';
import { groupSignalsByRequest, type Signal, type SignalAnswer, type SignalRequest } from '../net/signals.js';
import { answerSignalRequest, subscribeToSignalChanges } from '../store/signalResolve.js';

// Data layer for session signals — the open questions and notifications a
// session is waiting on.
//
// Same shape of problem as `refDetail.ts`, and for the same reason: a RefChip is
// a passive linkification of an id, so one transcript can mount many chips on
// the SAME session, and every open panel would otherwise put its own /signals
// request on the wire. Loads therefore go through a short-lived promise cache
// keyed by session id and the duplicates share one flight.
//
// It is NOT `refDetail.ts`'s cache, and not because of where the code lives: a
// chip detail is read-only and can simply age out, while a signal is ANSWERED
// from the surface that displays it. This cache has to be invalidated the
// instant a resolve lands anywhere in the tab, which is what
// `subscribeToSignalChanges` delivers and what a pure TTL cannot.

/** How long an open-signal read stays fresh. Matches `refDetail.ts`'s
 *  `REF_TTL_MS`: a signal panel shows live state, and a stale question is worse
 *  than a second request. Resolves invalidate this on their own, so the TTL only
 *  has to cover signals minted or closed by someone else. */
const OPEN_SIGNALS_TTL_MS = 30_000;

interface CacheSlot {
  at: number;
  /** null is the real answer for "this bridge-server has no /signals route". */
  promise: Promise<Signal[] | null>;
}

/** Keyed by session id; '' is the cross-session inbox read. */
const openSignalsCache = new Map<string, CacheSlot>();

/** Drop every cached signal read. Tests call this between cases; the app calls
 *  it through the resolve path, which has to invalidate rather than wait out the
 *  TTL. */
export function clearOpenSignalsCache(): void {
  openSignalsCache.clear();
}

/** What a signal surface knows at any moment. */
export interface OpenSignalsState {
  /** Open chat signals for this session, newest first as the server ordered
   *  them. Empty while loading, empty on a server with no signals route. */
  signals: Signal[];
  /** The same signals grouped into the unit that actually gets answered. */
  requests: SignalRequest[];
  /** False once the server has answered 404 — this bridge-server has no signals
   *  route, so every signal surface stays hidden rather than erroring. */
  available: boolean;
  loading: boolean;
  error: string | null;
  /** Re-read from the server, dropping the cached flight for this session. */
  reload: () => void;
  /**
   * Submit one whole request group. Offered for a host that renders its own
   * answer UI; the shipped `SignalRequestCard` calls the same store verb
   * directly, so both go through one implementation of the resolve semantics.
   *
   * `answersBySignalId` is keyed by signal id (what a form holds). The
   * title-keyed payload the server pairs answers by is derived inside the verb.
   */
  resolve: (
    request: SignalRequest,
    answersBySignalId: Readonly<Record<string, SignalAnswer>>,
  ) => Promise<void>;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Open chat signals for one session, or across every session when `sessionId` is
 * omitted.
 *
 * There is no signal event on the SSE stream yet, so freshness comes from three
 * places and none of them is a timer: the 30s cache TTL, an explicit `reload`,
 * and the in-process announcement every resolve makes — which is what keeps two
 * surfaces showing the same session from disagreeing about whether its question
 * is still open.
 */
export function useOpenSignals(sessionId?: string): OpenSignalsState {
  const { api } = useChatContext();
  const key = sessionId ?? '';
  const [signals, setSignals] = useState<Signal[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    // Dropping the slot first is what makes this a re-READ. Bumping the token
    // alone would re-run the effect and be handed the same cached promise.
    openSignalsCache.delete(key);
    setReloadToken((t) => t + 1);
  }, [key]);

  // A resolve on any surface — this one, another chip, a host's own inbox —
  // means the open set may have changed here too.
  useEffect(() => subscribeToSignalChanges(reload), [reload]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const now = Date.now();
    const hit = openSignalsCache.get(key);
    let flight: Promise<Signal[] | null>;
    if (hit && now - hit.at < OPEN_SIGNALS_TTL_MS) {
      flight = hit.promise;
    } else {
      flight = api.getOpenChatSignals(sessionId ? { sessionId } : undefined);
      openSignalsCache.set(key, { at: now, promise: flight });
      // A rejection must not be cached as a permanent failure — the next panel
      // to open should be free to retry. Only evict this exact promise, or a
      // retry already in flight would be thrown away with it.
      flight.catch(() => {
        if (openSignalsCache.get(key)?.promise === flight) openSignalsCache.delete(key);
      });
    }
    flight.then(
      (result) => {
        if (!live) return;
        setError(null);
        // null is the 404: the feature is not deployed here. Not an error, and
        // not an empty list that would read as "deployed and quiet".
        setAvailable(result !== null);
        setSignals(result ?? []);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(messageOf(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [api, key, sessionId, reloadToken]);

  const requests = useMemo(() => groupSignalsByRequest(signals), [signals]);

  const resolve = useCallback(
    (request: SignalRequest, answersBySignalId: Readonly<Record<string, SignalAnswer>>) =>
      answerSignalRequest(api, request, answersBySignalId),
    [api],
  );

  return { signals, requests, available, loading, error, reload, resolve };
}
