# chat-core public API

The surface the dashv2 page consumes. The client implementation (`src/react/*`, `src/store/*`)
must export exactly these; the dash page imports only these. Kept stable so the page and the
library can be built in parallel.

```ts
import type { ReactNode } from 'react';
import type {
  SessionSummary, TurnModel, Entry, Turn,
  SessionInfo, ToolInfo, McpServerInfo, ManagedSessionDetail,
} from '@kayushkin/chat-core';

// ---- Provider ----
export interface ChatProviderProps {
  fetch: typeof fetch;          // dash passes its cookie-credentialed apiFetch
  basePath: string;             // '/api/bridge'
  recentN?: number;             // warm-cache size, default 20
  turnsPerBundle?: number;      // last-N turns per bundled session, default 30
  cache?: boolean;              // enable IndexedDB persistence, default true
  children: ReactNode;
}
export function ChatProvider(props: ChatProviderProps): JSX.Element;

// ---- Selectors / hooks (all read from the in-memory store; no network on the hot path) ----

// Sidebar list, already filtered + grouped + sorted by the current filter/folder state.
// `effectiveState(sessionId)` returns the tail-reconciled state for a row's status dot: a
// session the server still reports as running/holding but whose warm tail is terminal reads
// as completed/failed (F1 self-heal). Cold sessions return their raw summary state.
export function useSessionList(): {
  groups: { folder: string; sessions: SessionSummary[] }[];
  total: number;
  loading: boolean;
  effectiveState: (sessionId: string) => string;
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
export function useSessionActions(): {
  newSession: (opts?: { instanceId?: string; harness?: string }) => void; // opens pending pane, 0 network
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  rename: (id: string, name: string) => void;
};

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

// Prefetch hint (call on sidebar row hover) — warms a cold session so the click is instant.
export function usePrefetch(): (sessionId: string) => void;

export interface FilterState {
  harness: string | null;
  status: string | null;
  type: string | null;
  purpose: string | null;
  mode: string | null;
  folder: string | null; // e.g. 'archive'
  search: string;
}

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
// snake_case `info` to a camelCase `SessionInfo` (info=null when the harness reported none);
// it backs useSessionInfo. Throws loud on non-2xx like the rest.
// class ApiClient {
//   interrupt(id: string): Promise<unknown>;
//   search(q: string): Promise<SearchResponse>;
//   getSessionDetail(id: string): Promise<ManagedSessionDetail>;  // { summary, info }
// }
```

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
