// @kayushkin/chat-core — framework-light data layer for the dashv2 chat surface.
// The client renders from memory; the network only reconciles.

// ---- Public React surface (docs/PUBLIC-API.md) ----
export { ChatProvider, type ChatProviderProps } from './react/Provider.js';
export {
  useSessionList,
  useActiveSession,
  useTurns,
  useComposer,
  useFilters,
  useSessionActions,
  usePrefetch,
} from './react/hooks.js';

// ---- Wire types (docs/WIRE.md, src/net/types.ts) ----
export type {
  SessionSummary,
  Validator,
  EntrySource,
  EntryKind,
  Role,
  Entry,
  Turn,
  TurnModel,
  SummaryResponse,
  RecentBundleResponse,
  ValidatorsResponse,
  MessagesResponse,
} from './net/types.js';
export type {
  WireEvent,
  WireEventData,
  ManagedSessionWire,
  SessionListFrame,
} from './net/wireEvents.js';

// ---- Store + selectors ----
export {
  createChatStore,
  EMPTY_FILTER,
  type ChatState,
  type ChatActions,
  type ChatStoreApi,
  type ConnState,
  type FilterState,
  type PendingSession,
} from './store/ChatStore.js';
export {
  visibleSessions,
  visibleCount,
  activeSummary,
  turnsFor,
  turnList,
  entriesFor,
  visibleEntryIdsFor,
  sourcesForEntry,
  matchesFilter,
  type FolderGroup,
} from './store/selectors.js';

// ---- Reduce (pure, ported logic) ----
export {
  applyEvent,
  applyEvents,
  initTailState,
  type TailState,
} from './reduce/TurnReducer.js';
export {
  annotateOTelDuplicates,
  groupMembers,
  isOTelSourced,
} from './reduce/otelDedup.js';
export {
  parseRefChips,
  remarkRefChips,
  type RefKind,
  type RefSegment,
} from './reduce/refChips.js';

// ---- Cache ----
export {
  SessionCache,
  type HydratedCache,
  type CachedListRow,
} from './cache/SessionCache.js';
export { selectEvictions, enforceCacheBound, DEFAULT_CACHE_LIMIT } from './cache/evict.js';

// ---- Sync ----
export { SyncEngine, type SyncEngineConfig } from './sync/SyncEngine.js';
export { connectListSSE, connectSessionSSE, summaryFromManaged } from './sync/sse.js';

// ---- Boot ----
export { Prefetcher, type PrefetcherConfig } from './boot/Prefetcher.js';

// ---- Net ----
export { ApiClient, type ApiClientConfig, type CreatedSession, type SendResult } from './net/ApiClient.js';
