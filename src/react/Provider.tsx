import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { ApiClient } from '../net/ApiClient.js';
import { SessionCache } from '../cache/SessionCache.js';
import { SyncEngine } from '../sync/SyncEngine.js';
import { Prefetcher } from '../boot/Prefetcher.js';
import { createChatStore } from '../store/ChatStore.js';
import { ChatContext, type ChatContextValue } from './context.js';

/** Props for the ChatProvider (see docs/PUBLIC-API.md). */
export interface ChatProviderProps {
  fetch: typeof fetch; // dash passes its cookie-credentialed apiFetch
  basePath: string; // '/api/bridge'
  recentN?: number; // warm-cache size, default 20
  turnsPerBundle?: number; // last-N turns per bundled session, default 30
  sessionsPerPage?: number; // sidebar sessions per page, default 100
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
    recentN = 20,
    turnsPerBundle = 30,
    sessionsPerPage,
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
    });
    // The page size goes to BOTH: the Prefetcher paints one page from the cache
    // and the SyncEngine's sweep trims the cache to it. Configure one and not the
    // other and the sweep drops rows the next boot paint wanted.
    const sync = new SyncEngine({ store, api, cache: sessionCache, sessionsPerPage });
    ctxRef.current = { store, api, cache: sessionCache, sync, prefetcher };
  }

  const ctx = ctxRef.current;

  useEffect(() => {
    let cancelled = false;
    void ctx.prefetcher.boot().then(() => {
      if (!cancelled) ctx.sync.start();
    });
    return () => {
      cancelled = true;
      ctx.sync.stop();
      void ctx.cache.close();
    };
    // ctx is stable for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ChatContext.Provider value={ctx}>{children}</ChatContext.Provider>;
}
