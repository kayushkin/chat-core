// Wire types — the shared contract between llm-bridge-server / log-store (Go) and this
// client. Keep this file and docs/WIRE.md in lockstep with the Go structs. Timestamps are
// RFC3339 strings WITH offset (never naive). Nothing here is lossy: every event/source that
// exists in the store is representable and transmitted; dedup is expressed as ANNOTATION
// (`duplicate` / `primary` / `groupId`), never omission.

/** Projected session-list row for the sidebar. Deliberately omits the heavy `info` /
 *  `harness_config` blobs — those are fetched lazily per session when actually needed. */
export interface SessionSummary {
  sessionId: string;
  state: string;
  harness: string;
  instanceId: string;
  type: string;
  purpose: string;
  mode: string;
  folderName: string;
  displayName: string;
  agentId: string;
  updatedAt: string; // RFC3339 + offset
  createdAt: string; // RFC3339 + offset
}

/** Cheap staleness currency. A cached TurnModel is fresh iff its validator equals the
 *  server's for that session. Comparing these avoids shipping any messages. */
export interface Validator {
  maxEventId: number;
  eventCount: number;
  updatedAt: string; // RFC3339 + offset
}

export type EntrySource = 'harness' | 'otel';

export type EntryKind =
  | 'text' // assistant/user prose
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'result'
  | 'error'
  | 'meta'; // catch-all for anything not specially rendered

export type Role = 'user' | 'assistant' | 'system' | 'tool';

/**
 * One renderable atom, mapped 1:1 to a stored event. This is the unit of the
 * non-destructive dedup model:
 *  - EVERY event becomes exactly one Entry — nothing is dropped.
 *  - `duplicate=true` means "hidden from the collapsed Turns view", NOT deleted. The raw
 *    Timeline view renders all entries regardless.
 *  - Entries that represent the same logical content across sources (e.g. a harness
 *    assistant message and its ~1s-late OTel copy) share a `groupId`; exactly one of them
 *    has `primary=true`. The sources badge counts a group's members.
 */
/** Per-entry token usage, mirrored 1:1 from the source event (camelCase on the wire —
 *  log-store populates these directly, no client mapping). MAY be absent when the event
 *  carried no usage (e.g. a user_message or a system entry). Never invented. */
export interface EntryUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Entry {
  id: string; // stable per-entry key (message_id + role, or synthesized from event_id)
  turnId: string; // groups entries into a turn
  role: Role;
  kind: EntryKind;
  source: EntrySource;
  eventId: number; // the log-store event row id — monotonic, used for ordering + resume
  ts: string; // RFC3339 + offset

  /** Token usage for this entry, when the source event reported it. camelCase on the
   *  wire; read directly by the UI (`entry.usage`) — there is no per-entry hook. */
  usage?: EntryUsage;

  // Rendered payload (kind-dependent; unused fields omitted):
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  raw?: unknown; // original event payload, for the raw Timeline view / audit

  // Provenance / kind-specific fields (mapped from the canonical wire, never invented):
  /** true when this assistant text was recovered from the OTel copy after the live
   *  stream produced nothing (`extensions.recovered`). Never gates visibility. */
  recovered?: boolean;
  /** error entries (kind 'error'): the canonical ErrorEvent fields. `code` values like
   *  TURN_IDLE_TIMEOUT / PROCESS_DIED are turn terminators; api_error /
   *  api_retries_exhausted are informational chips. */
  code?: string;
  retryable?: boolean;
  statusCode?: number;
  /** system entries (kind 'system'): the SystemEvent subtype (e.g. subagent_completed,
   *  compact_boundary). An unknown subtype must render generically, never as an error. */
  subtype?: string;

  // Non-destructive dedup annotations:
  duplicate: boolean; // hidden in collapsed Turns view; always shown in raw Timeline
  primary: boolean; // the copy shown for its group in the collapsed view
  groupId?: string; // members share identical logical content across sources
}

export interface Turn {
  id: string;
  role: Role;
  ts: string;
  entryIds: string[]; // order within the turn, by eventId
}

/** Rolled-up cost/context figures for a session's materialized model, populated by
 *  log-store's spend/context materializer (camelCase on the wire, mirrored directly).
 *  MAY be undefined — or carry undefined members — when the spend/context events fall
 *  outside the currently loaded page; consumers must treat absence as zero, never
 *  fabricate a figure. `useSessionCost` / `useContextUsage` read from here. */
export interface TurnAggregates {
  totalUsd?: number;
  byModel?: Record<string, number>;
  byQuerySource?: Record<string, number>;
  contextTokens?: number;
  contextLimit?: number;
}

/** The render-ready, fully-annotated model for one session. Holds EVERY entry; the
 *  collapsed Turns view is a pure selector over `entries` (filter !duplicate), the raw
 *  Timeline view renders all of `entries`. */
export interface TurnModel {
  sessionId: string;
  turns: Turn[];
  entries: Record<string, Entry>; // id -> Entry (all sources, all copies)
  validator: Validator;
  more: boolean; // true if older turns exist beyond this page (paginate with `before`)
  /** Cost/context roll-up for the loaded page; undefined when the materializer has not
   *  attached one (spend/context events outside the page). Read via the cost/context hooks. */
  aggregates?: TurnAggregates;
}

/** A tool the harness reports as available to the agent (SessionInfo.tools[]).
 *  `description` is optional — the harness only reports what the agent exposes. */
export interface ToolInfo {
  name: string;
  description?: string;
}

/** An MCP server connection reported by the agent (SessionInfo.mcpServers[]). */
export interface McpServerInfo {
  name: string;
  status?: string;
}

/** What the harness knows about a session at start: the configured system prompt,
 *  working dir, model, permission mode, and the tools / slash commands / sub-agents /
 *  skills / MCP servers the underlying agent reports. camelCase after the client maps
 *  it; the WIRE is snake_case `msg.SessionInfo` (system_prompt, working_dir, …), mapped
 *  explicitly in `ApiClient.getSessionDetail`. Fetched lazily per session via
 *  `useSessionInfo`; absent fields stay absent (never guessed). */
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

/** The raw approval/sandbox knobs under `harnessConfig.permissionModeCustom` (the
 *  power-user "custom" permission mode). camelCase of `HarnessConfigCustomWire`. */
export interface HarnessConfigCustom {
  approval?: string;
  sandbox?: string;
}

/** A session's per-harness config bag (`harness_config` on the wire; opaque
 *  `json.RawMessage` on the Go side). The bridge's own well-known keys are surfaced in
 *  camelCase; the index signature carries any harness-specific knob through unchanged so
 *  the layer stays transparent and lossless. Fields:
 *   - `permissionMode` — the per-session prehook gate (ask / auto / bypass / plan / …);
 *     what the interactive permission-mode selector reads and writes.
 *   - `disableNetwork` — the sandbox "no outbound network" gate (harnesses that support it).
 *   - `permissionModeCustom` — raw approval/sandbox knobs for the "custom" mode.
 *   - `model` / `effort` — the per-harness defaults snapshotted at session create.
 *  Absent fields stay absent; nothing is invented. */
export interface HarnessConfig {
  permissionMode?: string;
  disableNetwork?: boolean;
  permissionModeCustom?: HarnessConfigCustom;
  model?: string;
  effort?: string;
  [k: string]: unknown;
}

/** The full per-session detail from `GET /sessions/{id}` (the canonical ManagedSession),
 *  with its snake_case `info` mapped to camelCase `SessionInfo` and `harness_config`
 *  mapped to `HarnessConfig`. `info` / `harnessConfig` are null when the harness has not
 *  reported / carries none. `sessionId` is surfaced at the top level (it also lives on
 *  `summary`) so a consumer holding just the detail can identify the session. */
export interface ManagedSessionDetail {
  sessionId: string;
  summary: SessionSummary;
  info: SessionInfo | null;
  harnessConfig: HarnessConfig | null;
}

// ---- Endpoint response shapes ----

export interface SummaryResponse {
  sessions: SessionSummary[];
  next: string | null; // cursor for the next page, or null
  revision: string; // ETag-equivalent; also returned as the ETag header
}

/** recent-bundle: warms the N most-recent sessions in one round trip. */
export type RecentBundleResponse = Record<
  string,
  { summary: SessionSummary; model: TurnModel }
>;

export type ValidatorsResponse = Record<string, Validator>;

export interface MessagesResponse {
  model: TurnModel;
}

/** One content-search hit: the session whose transcript matched, plus an optional
 *  snippet for highlighting. `snippet` is advisory; the list path only needs the id. */
export interface SearchHit {
  sessionId: string;
  snippet?: string;
}

/** `GET /sessions/search?q=` — the session ids whose materialized transcript text
 *  matches `q`. This is the async augmentation of the instant local name filter:
 *  the client folds `sessionIds` into the search-filter path so a query matches
 *  transcript content, not just the display name. `hits` (optional) carries the
 *  same ids with snippets when the backend supplies them. */
export interface SearchResponse {
  sessionIds: string[];
  hits?: SearchHit[];
}
