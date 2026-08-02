# chat-core public API

The surface the dashv2 page consumes. The client implementation (`src/react/*`, `src/store/*`)
must export exactly these; the dash page imports only these. Kept stable so the page and the
library can be built in parallel.

```ts
import type { ReactNode } from 'react';
import type {
  SessionSummary, TurnModel, Entry, Turn,
  SessionInfo, ToolInfo, McpServerInfo, ManagedSessionDetail,
  HarnessConfig, HarnessConfigCustom, Facets,
  HarnessMeta, ModelOption, SessionConfig,
} from '@kayushkin/chat-core';

// ---- Provider ----
export interface ChatProviderProps {
  fetch: typeof fetch;          // dash passes its cookie-credentialed apiFetch
  basePath: string;             // '/api/bridge'
  recentN?: number;             // warm-cache size, default 20
  turnsPerBundle?: number;      // last-N turns per bundled session, default 30
  sessionsPerPage?: number;     // sidebar sessions per page, default 100
  cache?: boolean;              // enable IndexedDB persistence, default true
  children: ReactNode;
}
export function ChatProvider(props: ChatProviderProps): JSX.Element;

// ---- Selectors / hooks (all read from the in-memory store; no network on the hot path) ----

// Liveness of the global session-list SSE stream, as SyncEngine reports it. Separates
// "still connecting" from "you genuinely have no sessions", and says when the client has
// stopped receiving updates at all.
//
// The four values are not evenly likely: 'idle' is the window between mount and
// SyncEngine.start() (the boot prime runs first); 'connecting' covers the first attach AND
// every backoff reconnect, so a dropped stream reads as connecting; 'closed' is set only by
// SyncEngine.stop(), i.e. on unmount. The honest test for "updates are flowing" is
// `=== 'open'`, NOT `!== 'closed'`.
export function useConnState(): ConnState;
export type ConnState = 'idle' | 'connecting' | 'open' | 'closed';

// Sidebar list, already filtered + grouped + sorted by the current filter/folder state.
// `effectiveState(sessionId)` returns the tail-reconciled state for a row's status dot: a
// session the server still reports as running/holding but whose warm tail is terminal reads
// as completed/failed (F1 self-heal). Cold sessions return their raw summary state.
// `facets` are cross-axis counts over the FULL loaded session set (independent of the
// active filter), so the sidebar can render every available option + count and offer
// multi-select. Memoized on the sessions Map identity. (A `useFacets()` hook was NOT
// added — facets ride on `useSessionList` since the sidebar renders both together.)
//
// The list is ONE PAGE deep on boot (`sessionsPerPage`, default 100), because this box
// carries thousands of sessions and loading them all is the unbounded list the rewrite
// exists to kill. `moreSessions` is true while the server holds older sessions the client
// has not loaded, and `loadOlderSessions()` pulls the next cursor page and MERGES it —
// a sidebar that renders neither leaves every session past the first page unreachable.
// `total` counts the loaded-and-filter-passing rows and is never a server total: the
// summary endpoint reports no count, so "at least one more page" is the strongest honest
// claim. Filtering and `facets` are computed over the loaded window only, so paging is
// also what widens what a filter can reach.
export function useSessionList(): {
  groups: { folder: string; sessions: SessionSummary[] }[];
  total: number;
  loading: boolean;
  effectiveState: (sessionId: string) => string;
  facets: Facets;
  moreSessions: boolean;
  loadingOlderSessions: boolean;
  loadOlderSessions: () => void;
};

// Active session id + setter. select() is synchronous: it swaps the active id and renders
// from cache immediately (sub-10ms); any needed fetch/reconcile happens in the background.
// `summary.state` is reconciled against the warm tail (see effectiveState), so a stale
// running/holding state clears once the session is open.
export function useActiveSession(): {
  id: string | null;
  select: (id: string) => void;
  summary: SessionSummary | null;
};

// Turns for a session. `view: 'turns'` = collapsed (dupes hidden); `view: 'raw'` = every
// entry incl. duplicates, ordered by eventId. `sourcesFor(entryId)` returns the group's
// members for the sources badge. Never throws on a cold session — returns loading + triggers
// a background tail fetch.
export function useTurns(sessionId: string | null, view?: 'turns' | 'raw'): {
  turns: Turn[];
  entries: Record<string, Entry>;
  visibleEntryIds: (turnId: string) => string[]; // respects `view`
  sourcesFor: (entryId: string) => Entry[];       // all copies in the entry's group
  loading: boolean;
  more: boolean;
  loadOlder: () => void;
};

// Composer + turn controls for a session (or the pending/new pane). Optimistic:
// append() shows the user text instantly and reconciles the message id after POST.
// Creating the real session is lazy on first send for a pending pane.
//
// `stop()` interrupts the running turn (POST /sessions/{id}/interrupt). It is a LOUD
// control: it throws on a non-2xx (e.g. the 409 the server returns while a tool still
// holds the turn), sets `error`, and does NOT optimistically mark the session idle —
// a failed stop must be visible, never swallowed into a fake-idle. `interrupting` is
// true for the request's duration. `paused` reflects a parked/held session (the
// explicit 'paused' state; never gate on a bare `state === 'running'` — `tool_running`
// is also busy). `error` is the last send/stop error message, or null.
export function useComposer(sessionId: string | null): {
  send: (text: string) => void;
  draft: string;
  setDraft: (t: string) => void;
  sending: boolean;
  stop: () => Promise<void>;
  interrupting: boolean;
  paused: boolean;
  error: string | null;
};

// Filters + folders (client-side over the loaded list; switching is sub-10ms).
// `set({ search })` matches the display name INSTANTLY/locally; it also fires an async
// content search (GET /sessions/search) whose hit ids are folded into the list path
// when they arrive, so the filter matches transcript text too — without ever blocking
// the local name filter on the network (C6).
export function useFilters(): {
  filter: FilterState;
  set: (patch: Partial<FilterState>) => void;
  openFolder: (folder: string) => void;
};

// Optimistic mutations. Each updates the store first, POSTs in the background, reverts on error.
// `newSession` opens the pending pane (0 network). `model`/`effort` are PRE-START settings:
// they ride on the pending pane and are applied via POST /sessions/{id}/config right after
// the real session is lazily created on first send — matching bridge-ui, whose create call
// carries no model/effort (application is best-effort on that optimistic path; the LOUD path
// for a live change is `useSessionControls().setConfig`).
export function useSessionActions(): {
  newSession: (opts?: { instanceId?: string; harness?: string; model?: string; effort?: string }) => void;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  rename: (id: string, name: string) => void;
}

// ---- Settings / controls bar (dashv2 `bc-controls-bar`) ----

// Live-session controls for the settings bar: compact / fork / switch-mode / model+effort.
// All are LOUD — the underlying ApiClient methods throw on any non-2xx; each control surfaces
// the message on `error` and RETHROWS rather than faking a success/idle. `compacting` is set
// on compact() and cleared only when the canonical `compact_boundary` system entry lands on
// the session stream (or a 180s safety timeout) — the POST only ACKs, so completion is never
// faked (mirrors bridge-ui). `forking` is true for the fork request; on success it navigates
// the store to the new fork (its summary arrives via the list SSE). `setConfig` is the live
// model/effort change (POST /config). `error` is the last control error, or null.
export function useSessionControls(sessionId: string | null): {
  compact: (summary?: string) => Promise<void>;
  fork: (displayName?: string) => Promise<void>;
  switchMode: (mode: 'events' | 'pty') => Promise<void>;
  setConfig: (config: SessionConfig) => Promise<void>;
  compacting: boolean;
  forking: boolean;
  error: string | null;
}

// The capability set the controls bar gates each control on:
// `capabilities.has('model' | 'effort' | 'compact' | 'fork' | 'system_prompt' | 'tools')`.
// Sourced from the CANONICAL `GET /harnesses` registry (never a hardcoded per-harness
// allowlist), fetched once on first use and cached/shared in the store. Returns an empty set
// until it loads or when the harness is unknown, so a control simply stays hidden.
export function useHarnessCapabilities(harnessId: string | null): Set<string>;

// The models for the controls-bar picker, from the CANONICAL `GET /models` registry (enabled
// rows only), filtered to the harness's `supportedProviders` exactly as bridge-ui's
// `harnessModels` does. Pass no harnessId (or a harness declaring no providers) for every
// enabled model. Fetched once on first use, cached/shared; returns `[]` until it loads.
// `value` is the model id (what the config POST sends).
export function useModels(harnessId?: string | null): ModelOption[];

// A registered harness type + capabilities, from GET /harnesses (camelCase of msg.HarnessInfo).
export interface HarnessMeta {
  name: string; label: string; emoji: string; tint?: string; available: boolean;
  capabilities: string[];            // the controls-bar gate set (single source of truth)
  hookEvents?: string[];
  supportedProviders?: string[];     // scopes the model picker
  supportedPermissionModes?: string[];
  pty: boolean;                      // gates the events/pty ModeToggle
  supportsDisableNetwork?: boolean;
}
export interface ModelOption { value: string; label: string; provider: string; }
export interface SessionConfig { model?: string; effort?: string; maxBudget?: number; disabledTools?: string[]; };

// ---- Session info + cost/context (Phase 2) ----

// Session detail info (system prompt, model, permission mode, tools, slash commands,
// sub-agents, skills, MCP servers). LAZY: fetches GET /sessions/{id} on first use, caches
// the result in the store keyed by id, and returns the cache thereafter — a cached `null`
// means the harness has reported no info yet and is NOT re-fetched. Never blocks the hot
// path (the fetch is backgrounded; the store update re-renders). `loading` is true only
// while the first fetch is in flight.
export function useSessionInfo(sessionId: string | null): {
  info: SessionInfo | null;
  loading: boolean;
};

// A session's rolled-up cost from the cached/active model's `TurnModel.aggregates`. PURE
// selector — no network. Every field is 0/{} when aggregates are absent (the spend events
// fell outside the loaded page).
export function useSessionCost(sessionId: string | null): {
  totalUsd: number;
  byModel: Record<string, number>;
  byQuerySource: Record<string, number>;
};

// A session's context-window usage from `TurnModel.aggregates`. PURE selector — no network.
// `pct = tokens/limit*100`, or 0 when the limit is missing; zeros when aggregates are absent.
export function useContextUsage(sessionId: string | null): {
  tokens: number;
  limit: number;
  pct: number;
};

// Per-entry token usage is read DIRECTLY off the entry (`entry.usage`) — there is no
// per-entry hook. It may be absent when the source event carried no usage.
export interface SessionInfo {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  workingDir?: string;
  model?: string;
  permissionMode?: string;
  tools?: ToolInfo[];
  slashCommands?: string[];
  agents?: string[];
  skills?: string[];
  mcpServers?: McpServerInfo[];
}
export interface ToolInfo { name: string; description?: string; }
export interface McpServerInfo { name: string; status?: string; }

// ---- Managed-session detail + permission mode (dashv2 follow-up) ----

// Full per-session detail (summary + info + harnessConfig) PLUS a permission-mode
// mutator — what the interactive SessionPermissionMode selector consumes. LAZY: fetches
// GET /sessions/{id} on first use, caches the ManagedSessionDetail in the store keyed by
// id, returns the cache thereafter. Never blocks the hot path (backgrounded fetch;
// the store update re-renders). `loading` is true only while the first fetch is in flight.
//
// `setPermissionMode(mode)` OPTIMISTICALLY patches the cached detail's
// `harnessConfig.permissionMode`, then PUTs /sessions/{id}/permission-mode. On a non-2xx
// it REVERTS the cached detail and rethrows — a failed change must be visible, never
// silently kept. Resolves once persisted. `mode` is a canonical PermissionMode value
// (ask | auto | bypass | plan | read | ask_all | block_all | custom).
export function useManagedSession(sessionId: string | null): {
  session: ManagedSessionDetail | null;
  loading: boolean;
  setPermissionMode: (mode: string) => Promise<void>;
};

// The hooks this session has parked on a human decision, plus the verb that answers one.
// A permission ask FREEZES the tool call and produces no other visible sign — no error, no
// state the composer reads, nothing in the turn list — so a client without this surface
// simply hangs. Hydrates GET /sessions/{id}/hooks/pending on session change (the session
// SSE resumes from Last-Event-ID and never replays a hook parked before the client
// attached), then the live stream keeps the set current: phase="awaiting_resolution"
// inserts, the matching phase="completed" clears. Both directions are idempotent.
//
// resolve() POSTs /sessions/{id}/hooks/{request_id}/resolve, clearing the card
// optimistically and RESTORING it on a non-2xx before rethrowing — the tool call is still
// parked when the server refuses, so an emptied banner would be a lie. `updatedInput`
// replaces the tool input wholesale: it is how a source="user_input" hook's answers reach
// the model.
export function usePendingPermissions(sessionId: string | null): {
  pending: PendingHook[];
  resolve: (input: HookResolveInput) => Promise<void>;
};

// One hook parked on a decision. `input` is the harness's own raw tool input, carried
// through untouched. `source` picks the card: HOOK_SOURCE_PERMISSION ("permission_prompt",
// and the empty default) is an allow/deny tool gate; HOOK_SOURCE_USER_INPUT ("user_input")
// is the model asking the human a structured question.
export interface PendingHook {
  requestId: string;
  event: string;
  phase: string;
  source: string;
  toolName?: string;
  matcher?: string;
  hookId?: string;
  input?: unknown;
}
export interface HookResolveInput {
  requestId: string;
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
  resolvedBy?: string;   // audit label; defaults to "user"
}

// The full detail carried by useManagedSession / ApiClient.getSessionDetail. `sessionId`
// is surfaced at the top level (also on `summary`). `info` / `harnessConfig` are null
// when the harness has reported / carries none.
export interface ManagedSessionDetail {
  sessionId: string;
  summary: SessionSummary;
  info: SessionInfo | null;
  harnessConfig: HarnessConfig | null;
}
// The per-harness config bag (wire `harness_config`, opaque json.RawMessage on the Go
// side). Bridge-owned well-known keys are surfaced camelCase; the index signature carries
// any unnamed harness-specific knob through unchanged (lossless). `permissionMode` is what
// the selector reads/writes; `disableNetwork` + `permissionModeCustom` are the sandbox /
// custom-mode knobs; `model` / `effort` are the per-harness defaults snapshot.
export interface HarnessConfig {
  permissionMode?: string;
  disableNetwork?: boolean;
  permissionModeCustom?: HarnessConfigCustom;
  model?: string;
  effort?: string;
  [k: string]: unknown;
}
export interface HarnessConfigCustom { approval?: string; sandbox?: string; }

// Prefetch hint (call on sidebar row hover) — warms a cold session so the click is instant.
export function usePrefetch(): (sessionId: string) => void;

// FilterState (BREAKING vs Phase 1): the faceted axes are now MULTI-SELECT `string[]`
// (was `string | null`), and a new `machine` axis is added. An EMPTY array means "no
// filter on this axis". Matching is OR *within* an axis (any selected value matches)
// and AND *across* axes (every non-empty axis must match). `folder` and `search` keep
// their scalar semantics. Dash consumers must migrate: `set({ harness: 'codex' })` →
// `set({ harness: ['codex'] })`, and read/toggle these as arrays.
//
// The `machine` axis matches `SessionSummary.instanceId` — the summary carries NO
// machine field, and instanceId is the value the dash resolves to a machine display
// name (bridge-ui `useBridgeMachines`). So the dash passes instanceId values here
// (grouped by machine on its side); `selectFacets().machine` is likewise keyed by
// instanceId. See "Canonical field flagged" in the handoff note.
export interface FilterState {
  harness: string[];
  status: string[];
  type: string[];
  purpose: string[];
  mode: string[];
  machine: string[];   // matches SessionSummary.instanceId (no machine field on summary)
  folder: string | null; // e.g. 'archive' — unchanged scalar
  search: string;         // unchanged
}

// Cross-axis facet counts over the FULL loaded session set (NOT the filtered list), so
// the sidebar can show every available option with its count and support cross-axis
// selection. `status` counts `SessionSummary.state`; `machine` counts `instanceId`.
// Empty-string axis values are skipped. Exposed via `useSessionList().facets` (below)
// and as the pure selector `selectFacets(state)`.
export interface Facets {
  harness: Record<string, number>;
  status: Record<string, number>;
  type: Record<string, number>;
  purpose: Record<string, number>;
  mode: Record<string, number>;
  machine: Record<string, number>;
}
export function selectFacets(state: ChatState): Facets;

// ---- Timeline pane selector (Path A) ----
// A pure, memoized transform of a materialized model into the event-granular,
// turn→task-grouped structure the Timeline pane renders. Returns DATA, not JSX, so
// the pane stays presentation-only and never re-derives. Memoized on model identity.
// Mirrors the grouping semantics of bridge-ui Timeline.tsx (group by turn, sub-group
// tool/thinking/result/error, respect task_* scoping); being the raw audit surface it
// represents every entry, ordered by eventId.
export function selectTimeline(model: TurnModel | undefined): TimelineView;

export interface TimelineView {
  items: TimelineItem[];          // flat, ordered — every event
  turns: TimelineTurnGroup[];     // turn → task grouped tree
  count: number;
}
export interface TimelineTurnGroup { turnId: string; header: TimelineItem; children: TimelineNode[]; }
export type TimelineNode =
  | { type: 'item'; item: TimelineItem }
  | { type: 'task'; taskId: string; header: TimelineItem; children: TimelineItem[] };
export interface TimelineItem {
  key: string; entryId: string; turnId: string; taskId?: string;
  icon: string; label: string; detail?: string; fullText?: string;
  ts: string; tone: TimelineTone;
}
export type TimelineTone =
  | 'turn' | 'task-start' | 'thinking' | 'tool' | 'tool-done' | 'tool-err'
  | 'result' | 'error' | 'system' | 'text';

// ---- Reference chips (dash TurnList wiring) ----
// Pure matcher + a remark transformer (dependency-free) and a minimal React renderer.
// Wire into ReactMarkdown:  remarkPlugins={[remarkRefChips]} components={{ 'ref-chip': RefChip }}
export function parseRefChips(value: string): RefSegment[];
export function remarkRefChips(): (tree: unknown) => void;
export function RefChip(props: RefChipProps): JSX.Element;

// ---- ApiClient additions ----
// interrupt() fails LOUD (throws on non-2xx, incl. the 409 "nothing was stopped");
// search() returns the session ids whose transcript text matched, for filter folding.
// getSessionDetail() GETs the full ManagedSession from GET /sessions/{id} and maps its
// snake_case `info` → camelCase `SessionInfo` (info=null when the harness reported none)
// AND its snake_case `harness_config` → camelCase `HarnessConfig` (null when absent); it
// backs useSessionInfo + useManagedSession. setPermissionMode() PUTs
// /sessions/{id}/permission-mode with `{ mode }` (fails loud on non-2xx). All throw loud
// on non-2xx like the rest.
// class ApiClient {
//   interrupt(id: string): Promise<unknown>;
//   search(q: string): Promise<SearchResponse>;
//   getSessionDetail(id: string): Promise<ManagedSessionDetail>;  // { sessionId, summary, info, harnessConfig }
//   setPermissionMode(id: string, mode: string): Promise<unknown>;
//   getPendingHooks(id: string): Promise<PendingHook[]>;                      // GET /sessions/{id}/hooks/pending — unwraps msg.Event.hook, keeps resolvable awaiting entries
//   resolveHook(id: string, input: HookResolveInput): Promise<unknown>;       // POST /sessions/{id}/hooks/{request_id}/resolve — { behavior, resolved_by, updated_input?, message? }
// }
```

### ApiClient — controls-bar additions (all LOUD: throw on any non-2xx)

Mirror the exact canonical bridge endpoints (verified against bridge-ui `useBridgeSession.ts`).
`createSession`/`fork` read the id from the canonical `session_id` wire key (POST /sessions and
/fork return the snake_case `msg.ManagedSession`; there is no `sessionId` on that shape).

```ts
// class ApiClient {
//   createSession(opts?: { instanceId?; harness? }): Promise<CreatedSession>; // maps session_id → sessionId
//   compact(id: string, summary?: string): Promise<unknown>;                   // POST /sessions/{id}/compact — {} or { summary }
//   fork(id: string, displayName?: string): Promise<CreatedSession>;           // POST /sessions/{id}/fork — { display_name, type:'interactive' }
//   switchMode(id: string, mode: 'events'|'pty'): Promise<unknown>;            // POST /sessions/{id}/mode — { mode }
//   setConfig(id: string, config: SessionConfig): Promise<unknown>;           // POST /sessions/{id}/config — { model?, effort?, max_budget?, disabled_tools? }
//   getHarnesses(): Promise<HarnessMeta[]>;                                     // GET /harnesses (canonical harness registry)
//   getModels(): Promise<ModelOption[]>;                                       // GET /models (enabled rows → ModelOption)
// }
```

Pure, framework-free selectors (exported for non-React consumers/tests):
`harnessCapabilities(harnesses, harnessId) → Set<string>` and
`modelsForHarness(models, harnesses, harnessId?) → ModelOption[]` — both read the canonical
registry lists, never a hardcoded allowlist.

Notes for implementers:
- All hooks read via Zustand selector subscriptions so only components whose slice changed
  re-render.
- `select()` / filter changes / `newSession` / `archive` must never await the network on the
  path that updates the UI.
- `useTurns(view:'raw')` and `sourcesFor` are the audit surface — they must expose every
  stored copy (see WIRE.md non-destructive dedup).
- Pure reconcile helpers are also exported for non-React consumers/tests:
  `terminalStateFromTail(model)` and `effectiveState(state, sessionId)` /
  `activeSummaryEffective(state)` (see WIRE.md "Client terminal-state reconcile").
