import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { ApiClient } from '../net/ApiClient.js';
import { NoteboardClient } from '../net/NoteboardClient.js';
import { ResolveClient } from '../net/ResolveClient.js';
import { SessionCache } from '../cache/SessionCache.js';
import { SyncEngine } from '../sync/SyncEngine.js';
import { Prefetcher } from '../boot/Prefetcher.js';
import { createChatStore } from '../store/ChatStore.js';
import { ChatContext, type ChatContextValue } from './context.js';

/** Props for the ChatProvider (see docs/PUBLIC-API.md). */
export interface ChatProviderProps {
  fetch: typeof fetch; // dash passes its cookie-credentialed apiFetch
  basePath: string; // '/api/bridge'
  /** Noteboard root, e.g. dash's '/api/noteboard'. Omit it and note/todo ref
   *  chips render but say lookup is not configured here — they never guess a
   *  path, because a wrong one would 404 as if the item did not exist. */
  noteboardBasePath?: string;
  /** The host's reference-resolver endpoint, e.g. dash's '/api/resolve'. Omit
   *  it and bare-uuid ref chips render as plain text — with no resolver there
   *  is no honest way to say what an unclassified id names. */
  resolveEndpoint?: string;
  recentN?: number; // warm-cache size, default 20
  turnsPerBundle?: number; // last-N turns per bundled session, default 30
  sessionsPerPage?: number; // sidebar sessions per page, default 100
  /** Stop background session deepening once the window holds this many sessions;
   *  0 disables deepening. Default 2000 — see `Prefetcher`. */
  backgroundSessionBudget?: number;
  cache?: boolean; // enable IndexedDB persistence, default true
  children: ReactNode;
}

/**
 * Wires ApiClient(fetch, basePath) + ChatStore + SessionCache, mounts the
 * SyncEngine, and runs the boot sequence (hydrate from cache → paint → parallel
 * prime). Everything is created exactly once for the provider's lifetime.
 */
export function ChatProvider(props: ChatProviderProps): JSX.Element {
  const {
    fetch: fetchFn,
    basePath,
    noteboardBasePath,
    resolveEndpoint,
    recentN = 20,
    turnsPerBundle = 30,
    sessionsPerPage,
    backgroundSessionBudget,
    cache = true,
    children,
  } = props;

  const ctxRef = useRef<ChatContextValue | null>(null);
  if (ctxRef.current === null) {
    const store = createChatStore();
    const api = new ApiClient({ fetch: fetchFn, basePath });
    const sessionCache = new SessionCache(cache);
    const prefetcher = new Prefetcher({
      store,
      api,
      cache: sessionCache,
      recentN,
      turnsPerBundle,
      sessionsPerPage,
      backgroundSessionBudget,
    });
    // The page size goes to BOTH: the Prefetcher paints one page from the cache
    // and the SyncEngine's sweep trims the cache to it. Configure one and not the
    // other and the sweep drops rows the next boot paint wanted.
    const sync = new SyncEngine({ store, api, cache: sessionCache, sessionsPerPage });
    // Built only when a path was given. An unconfigured noteboard is null all
    // the way to the chip, which then says so — rather than a client pointed at
    // the bridge root, whose 404 would read as "that item does not exist".
    const noteboard = noteboardBasePath
      ? new NoteboardClient({ fetch: fetchFn, basePath: noteboardBasePath })
      : null;
    const resolve = resolveEndpoint
      ? new ResolveClient({ fetch: fetchFn, endpoint: resolveEndpoint })
      : null;
    ctxRef.current = { store, api, cache: sessionCache, sync, prefetcher, noteboard, resolve };
  }

  const ctx = ctxRef.current;

  useEffect(() => {
    let cancelled = false;
    void ctx.prefetcher.boot().then(() => {
      if (!cancelled) ctx.sync.start();
    });
    return () => {
      cancelled = true;
      // Before the cache closes: the loop writes nothing to the cache, but it does
      // keep issuing requests, and a provider that has been torn down has no list
      // left to deepen.
      ctx.prefetcher.stopBackgroundDeepening();
      ctx.sync.stop();
      void ctx.cache.close();
    };
    // ctx is stable for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ChatContext.Provider value={ctx}>{children}</ChatContext.Provider>;
}
