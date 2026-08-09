import { useEffect, useState } from 'react';
import { useChatContext } from './context.js';
import type { ManagedSessionDetail, TurnModel } from '../net/types.js';
import type { NoteboardItem } from '../net/NoteboardClient.js';

// Data layer for reference chips. A chip is a passive linkification of an id
// that happens to appear in a message, so the same id can appear dozens of
// times in one transcript and each occurrence mounts its own chip. Fetching per
// chip would put dozens of identical requests on the wire for one render, so
// every loader here goes through a short-lived promise cache keyed by id and
// the duplicates share one flight.
//
// The cache is deliberately NOT the SessionCache: that one is the durable
// IndexedDB store for sessions the user actually opened, and a chip is a
// glance, not a visit. Polluting it with every id ever mentioned would evict
// real sessions from the warm list.

/** How long a resolved reference stays fresh. Short: a chip shows live-ish
 *  state (a session's `state`, a todo's `status`), and a stale badge is worse
 *  than a second request. Matches bridge-ui's chip cache. */
const REF_TTL_MS = 30_000;

interface CacheSlot<T> {
  at: number;
  promise: Promise<T>;
}

function takeCached<T>(
  cache: Map<string, CacheSlot<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < REF_TTL_MS) return hit.promise;
  const promise = load();
  cache.set(key, { at: now, promise });
  // A rejection must not be cached as a permanent failure — the next chip to
  // mount should be free to retry. Only evict this exact promise, or a retry
  // already in flight would be thrown away with it.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

const sessionDetailCache = new Map<string, CacheSlot<ManagedSessionDetail>>();
const noteboardItemCache = new Map<string, CacheSlot<NoteboardItem>>();
const transcriptCache = new Map<string, CacheSlot<TurnModel>>();

/** Drop every cached reference. Tests call this between cases; nothing in the
 *  app does, because entries age out on their own. */
export function clearRefDetailCache(): void {
  sessionDetailCache.clear();
  noteboardItemCache.clear();
  transcriptCache.clear();
}

/** What a chip knows about its target at any moment. `data` and `error` are
 *  mutually exclusive; both null means still loading. */
export interface RefDetailState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shared load-once-per-id effect. `enabled` false leaves the state idle
 *  without touching the network — that is how the transcript stays unfetched
 *  until the user asks for it. */
function useCachedRef<T>(
  key: string,
  enabled: boolean,
  load: () => Promise<T>,
): RefDetailState<T> {
  const [state, setState] = useState<RefDetailState<T>>({
    data: null,
    error: null,
    loading: enabled,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState({ data: null, error: null, loading: true });
    load().then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (e: unknown) => {
        if (live) setState({ data: null, error: messageOf(e), loading: false });
      },
    );
    return () => {
      live = false;
    };
    // `load` closes over the stable key; re-running on its identity would refetch
    // every render. The key and the enable flag are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return state;
}

/**
 * Full detail for a referenced session (`GET /sessions/{id}`), for the chip
 * label and its panel rows.
 *
 * This is the same endpoint `useSessionInfo` reads, but it is NOT that hook:
 * that one resolves the ACTIVE session through the store, and a chip points at
 * some other session the store has never listed.
 */
export function useSessionRefDetail(sessionId: string): RefDetailState<ManagedSessionDetail> {
  const { api } = useChatContext();
  return useCachedRef(sessionId, sessionId !== '', () =>
    takeCached(sessionDetailCache, sessionId, () => api.getSessionDetail(sessionId)),
  );
}

/**
 * A referenced noteboard item (`GET /api/items/{id}`) — note, todo, rank list
 * or workspace, whichever the id turns out to name.
 *
 * When the host configured no noteboard, this reports that as an error rather
 * than loading forever: a chip that cannot resolve should say why. The message
 * is deliberately plain, because it is shown to a user who can act on it.
 */
export function useNoteboardRefDetail(itemId: string): RefDetailState<NoteboardItem> {
  const { noteboard } = useChatContext();
  return useCachedRef(itemId, itemId !== '', () => {
    if (!noteboard) {
      return Promise.reject(new Error('noteboard lookup is not configured here'));
    }
    return takeCached(noteboardItemCache, itemId, () => noteboard.getItem(itemId));
  });
}

/** Turns to pull when a chip's transcript is expanded. The session's most
 *  recent activity is what a reader wants from a glance at a reference, and it
 *  is what the endpoint returns without a `before` cursor. */
export const REF_TRANSCRIPT_TURNS = 30;

/**
 * The referenced session's recent transcript, fetched ONLY once `enabled` turns
 * true — i.e. when the user expands the panel. This is the "fully load the
 * history" affordance, and it is opt-in per chip for a reason: the response is
 * a materialized turn model, and mounting one per chip in a long transcript
 * would fetch megabytes nobody asked to read.
 *
 * A limit always goes on the wire (see ApiClient.getMessages — the unbounded
 * shape of that endpoint returned 306MB for one real session on this box).
 * `model.more` tells the caller older turns exist beyond this page; this hook
 * does not paginate, and a reader who wants the rest opens the session.
 */
export function useSessionRefTranscript(
  sessionId: string,
  enabled: boolean,
): RefDetailState<TurnModel> {
  const { api } = useChatContext();
  return useCachedRef(sessionId, enabled && sessionId !== '', () =>
    takeCached(transcriptCache, sessionId, async () => {
      const resp = await api.getMessages(sessionId, { limit: REF_TRANSCRIPT_TURNS });
      return resp.model;
    }),
  );
}
