import { createContext, useContext } from 'react';
import type { ApiClient } from '../net/ApiClient.js';
import type { SessionCache } from '../cache/SessionCache.js';
import type { SyncEngine } from '../sync/SyncEngine.js';
import type { Prefetcher } from '../boot/Prefetcher.js';
import type { ChatStoreApi } from '../store/ChatStore.js';

/** The wired singletons the hooks read from. Created once by ChatProvider. */
export interface ChatContextValue {
  store: ChatStoreApi;
  api: ApiClient;
  cache: SessionCache;
  sync: SyncEngine;
  prefetcher: Prefetcher;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('chat-core hooks must be used inside <ChatProvider>');
  }
  return ctx;
}
