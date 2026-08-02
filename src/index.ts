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
  useSessionInfo,
  useManagedSession,
  useSessionControls,
  useHarnessCapabilities,
  useModels,
  useSessionCost,
  useContextUsage,
  usePendingPermissions,
  usePrefetch,
} from './react/hooks.js';
export { RefChip, type RefChipProps } from './react/RefChip.js';

// ---- Wire types (docs/WIRE.md, src/net/types.ts) ----
export type {
  SessionSummary,
  Validator,
  EntrySource,
  EntryKind,
  Role,
  Entry,
  EntryUsage,
  Turn,
  TurnModel,
  TurnAggregates,
  SessionInfo,
  ToolInfo,
  McpServerInfo,
  HarnessConfig,
  HarnessConfigCustom,
  HarnessMeta,
  PendingHook,
  HookResolveInput,
  ModelOption,
  SessionConfig,
  ManagedSessionDetail,
  SummaryResponse,
  RecentBundleResponse,
  ValidatorsResponse,
  MessagesResponse,
  SearchHit,
  SearchHitWire,
  SearchResponse,
} from './net/types.js';
export { HOOK_SOURCE_PERMISSION, HOOK_SOURCE_USER_INPUT } from './net/types.js';
export type {
  WireEvent,
  WireEventData,
  HookEventWire,
  ManagedSessionWire,
  ManagedSessionDetailWire,
  SessionInfoWire,
  ToolInfoWire,
  McpServerInfoWire,
  HarnessConfigWire,
  HarnessConfigCustomWire,
  HarnessInfoWire,
  StoreModelWire,
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
  type ContentHits,
  EMPTY_HOOKS,
} from './store/ChatStore.js';
export { changeSessionPermissionMode } from './store/permissionMode.js';
export {
  foldHookEvent,
  pendingHookFromWire,
  resolvePendingHook,
  HOOK_PHASE_AWAITING,
  HOOK_PHASE_COMPLETED,
} from './store/pendingHooks.js';
export {
  visibleSessions,
  visibleCount,
  activeSummary,
  activeSummaryEffective,
  effectiveState,
  turnsFor,
  turnList,
  entriesFor,
  visibleEntryIdsFor,
  sourcesForEntry,
  matchesFilter,
  selectFacets,
  selectContentSearchReach,
  sessionCost,
  contextUsage,
  harnessCapabilities,
  modelsForHarness,
  selectTimeline,
  type SessionCost,
  type ContextUsage,
  type Facets,
  type ContentSearchReach,
  type FolderGroup,
  type TimelineTone,
  type TimelineItem,
  type TimelineNode,
  type TimelineTurnGroup,
  type TimelineView,
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
export { terminalStateFromTail } from './reduce/terminalState.js';
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
