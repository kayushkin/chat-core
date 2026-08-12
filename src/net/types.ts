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
  /** The harness's OWN session id (rotates on resume/fork). For a promoted subagent
   *  session this is `agent-<task_id>` — the server-chosen key that ties the row back
   *  to the parent's `task_started` narration, and the join the live-status surface
   *  uses to link a running subagent line to its session. Empty until the harness
   *  reports one. */
  harnessSessionId: string;
  /** The managing session in the team tree (bridge session id); empty = top-level.
   *  A promoted subagent session carries its parent here. */
  managerSessionId: string;
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
  /** tool entries only: the source event carried no tool_id, so this entry can
   *  never be paired with its counterpart — a call here will never receive a
   *  result, and a result here will never find its call. OTel-derived tool
   *  stand-ins arrive this way by design. The edge must not render such a call
   *  as still running: it is not pending, it is unknowable. */
  unpairable?: boolean;
  /** Set when this entry is a subagent's own work rather than this session's:
   *  the tool_use_id of the Task call that spawned it (`harness_parent_id` on
   *  the wire).
   *
   *  The bridge server routes a subagent's frames into the subagent's own
   *  session, so a session's own model should almost never hold one. The
   *  exception is the server's fail-safe: a frame whose task_started was missed
   *  stays on the parent rather than being dropped. A view of what THIS session
   *  did must leave those out — they are another session's rows, sitting here
   *  because there was nowhere better to put them. */
  harnessParentId?: string;
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
  /** system entries describing a harness subagent (subtype `task_*`).
   *
   *  `taskId` names the subagent and is what the timeline groups its rows under;
   *  `toolUseId` ties it back to the tool call that spawned it. `taskStatus` is
   *  the only signal that the subagent finished — it emits no result event of
   *  its own — and `taskSummary` is its own report of what it did, which is the
   *  whole point of the notification. `taskOutputFile` is the transcript path,
   *  diagnostic only: never read it to reconstruct the summary. */
  taskId?: string;
  toolUseId?: string;
  taskStatus?: string;
  taskSummary?: string;
  taskOutputFile?: string;
  /** What kind of background work the task is (`local_agent`, `local_bash`, …).
   *  Only `task_started` carries it; without it a background `sleep 2` is
   *  indistinguishable from an agent. */
  taskType?: string;
  /** The agent role a subagent was spawned as (`Explore`, `general-purpose`, …).
   *  Only `task_started` carries it. */
  subagentType?: string;
  /** The bridge session id of the subagent a `task_*` entry describes — the id a
   *  client follows to read what that subagent did. Minted and stamped by
   *  llm-bridge-server, which owns it.
   *
   *  Empty means there is no session to link to, which is a real answer: a
   *  backgrounded shell task gets the same task frames a subagent does and
   *  deliberately never gets one. */
  subagentSessionId?: string;
  /** The tool the subagent last ran, from `task_progress` — the only live view a
   *  parent has into what its subagent is doing. */
  lastToolName?: string;

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

/** `HookEvent.source` — a hook that emits `permission_prompt` is the harness asking
 *  whether a tool call may proceed. The empty source means the same thing to this
 *  client: an allow/deny card. */
export const HOOK_SOURCE_PERMISSION = 'permission_prompt';

/** `HookEvent.source` — the model is asking the human a structured question (Claude
 *  Code's AskUserQuestion, ACP's request_user_input). The answer rides back as the
 *  resolve body's `updatedInput`, so "allow" carries data and bypass never applies:
 *  these always park for a human. */
export const HOOK_SOURCE_USER_INPUT = 'user_input';

/** A hook parked on a human decision — one `awaiting_resolution` HookEvent that no
 *  matching `completed` has closed yet. camelCase of `HookEventWire`. Hydrated from
 *  `GET /sessions/{id}/hooks/pending` and kept live by the session SSE; a session with
 *  one of these has a tool call frozen mid-turn and shows no other sign of it, which is
 *  why the banner is not optional.
 *
 *  `input` is the harness's own raw tool input, carried through untouched. */
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

/** A decision for one parked hook, as `POST /sessions/{id}/hooks/{request_id}/resolve`
 *  takes it. `updatedInput` REPLACES the tool input wholesale — it is how a
 *  `user_input` hook's answers reach the model. */
export interface HookResolveInput {
  requestId: string;
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
  /** Audit label for who decided; defaults to `user`. */
  resolvedBy?: string;
}

/** The raw approval/sandbox knobs under `harnessConfig.permissionModeCustom` (the
 *  power-user "custom" permission mode). camelCase of `HarnessConfigCustomWire`. */
export interface HarnessConfigCustom {
  approval?: string;
  sandbox?: string;
}

/** The three axes `PUT /sessions/{id}/permission-mode` writes in one body. camelCase
 *  of the request the bridge accepts (`mode` / `disable_network` /
 *  `permission_mode_custom`); the mapping to snake_case happens in `ApiClient`.
 *
 *  `mode` is required — the endpoint validates it server-side and rejects an empty
 *  one. The other two are optional and **absent means "leave the stored value alone"**,
 *  not "false" and not "clear": a caller that renders no network checkbox must not
 *  silently switch the sandbox back on by changing the mode. To CLEAR the custom knobs,
 *  send `permissionModeCustom` with both fields empty — that is the server's own
 *  "empty struct clears" contract, and it is the only way to say it. */
export interface SessionPermissionState {
  mode: string;
  disableNetwork?: boolean;
  permissionModeCustom?: HarnessConfigCustom;
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
 *  `summary`) so a consumer holding just the detail can identify the session.
 *
 *  The nine fields after `harnessConfig` are the identity, lineage and spend the endpoint
 *  has always returned and this type used to drop at the boundary. They live HERE and not
 *  on `summary`: `SessionSummary` is the sidebar row, and widening it would widen the
 *  session-list query for data only one session at a time ever needs.
 *
 *  Every one of them is optional and ABSENT MEANS ABSENT — the server omits what it has
 *  no value for, and a reader must render that as unknown rather than substituting a
 *  zero, an empty string or a dollar figure nobody reported. */
export interface ManagedSessionDetail {
  sessionId: string;
  summary: SessionSummary;
  info: SessionInfo | null;
  harnessConfig: HarnessConfig | null;

  /** Which service or script created this session (frontend-dash, autoworker, …). */
  origin?: string;
  /** OS process id of the harness process, while one is running. */
  pid?: number;
  /** The harness's OWN session id, which rotates on resume/fork. Never equal to
   *  `sessionId`. */
  harnessSessionId?: string;
  /** ⚠️ The FORK parent's `harnessSessionId` — a harness UUID, not a session id.
   *  Deprecated on the server in favour of `forkedFromSessionId`; do not label it
   *  simply "parent" in a UI, because it is not one. */
  forkParentHarnessSessionId?: string;
  /** The session this one was forked from, as a bridge session id. */
  forkedFromSessionId?: string;
  /** The managing session in the team tree (bridge session id); absent = top-level. */
  managerSessionId?: string;
  /** The directory the harness runs in. Absent inherits the instance's, then the
   *  machine's — it means "inherit", never "unknown". */
  workingDir?: string;
  /** Total derived API spend for this session, in US dollars. Absent when the server
   *  predates the spend gate; absent is NOT zero. */
  spendUsd?: number;
  /** The server-side spend ceiling. ⚠️ ZERO MEANS NO CEILING, not "halt now". */
  maxBudgetUsd?: number;
}

/** A registered harness type and its capabilities, from `GET /harnesses` (camelCase of
 *  `msg.HarnessInfo`). `capabilities` is the CANONICAL per-harness feature set the
 *  controls bar gates each control on (`model` / `effort` / `compact` / `fork` /
 *  `system_prompt` / `tools`); `supportedProviders` scopes the model picker to the
 *  providers this harness can run. Single source of truth — never a hardcoded
 *  per-harness allowlist. Absent optional fields stay absent; nothing is invented. */
export interface HarnessMeta {
  name: string;
  label: string;
  emoji: string;
  tint?: string;
  available: boolean;
  capabilities: string[];
  hookEvents?: string[];
  supportedProviders?: string[];
  supportedPermissionModes?: string[];
  pty: boolean;
  supportsDisableNetwork?: boolean;
}

/** One selectable model for the controls-bar picker, projected from `GET /models`
 *  (only `enabled` rows). `value` is the model id (exactly what the config POST sends),
 *  `label` is display text including per-million cost when reported, `provider` scopes
 *  the option to a harness's `supportedProviders`, and `shortName` is the model's dense
 *  nickname for a picker too narrow to show the full label. */
export interface ModelOption {
  value: string;
  label: string;
  provider: string;
  /** The model's short nickname (`opus-4.6`), empty when the registry has none for it.
   *
   *  REQUIRED, not optional, even though the wire field it comes from is optional and the
   *  value is often the empty string. The projection that builds this type writes a fresh
   *  object literal rather than spreading the wire row, so an optional field would let any
   *  construction site quietly omit it and still typecheck — the field would then be
   *  `undefined` at runtime in exactly the paths nobody remembered to update. Requiring it
   *  turns each of those omissions into a compile error at the site that has the wire row
   *  in hand and can actually answer the question. The empty string carries "no nickname"
   *  perfectly well and costs no extra type. */
  shortName: string;
}

/** The per-session runtime knobs applied via `POST /sessions/{id}/config`. camelCase
 *  here; mapped to the snake_case wire body (`model` / `effort` / `max_budget` /
 *  `disabled_tools`) by `ApiClient.setConfig`. `model` / `effort` are the controls-bar
 *  pre-start settings (applied right after create) and can also be changed on a live
 *  session; absent fields are omitted from the request (never sent as null). */
export interface SessionConfig {
  model?: string;
  effort?: string;
  maxBudget?: number;
  disabledTools?: string[];
}

// ---- Endpoint response shapes ----

export interface SummaryResponse {
  sessions: SessionSummary[];
  next: string | null; // cursor for the next page, or null
  revision: string; // ETag-equivalent; also returned as the ETag header
}

/** The axes `GET /sessions/summary` can narrow on, server-side.
 *
 *  These are exactly the six faceted axes of `FilterState`, so a `FilterState` is
 *  structurally assignable here and no mapping table is needed. `folder` and
 *  `search` are deliberately absent: the endpoint has no folder parameter, and
 *  transcript search is a different endpoint with its own ranking.
 *
 *  Semantics match the chips: an absent or empty axis constrains nothing, values
 *  within one axis are OR'd, and axes are AND'd. The server implements the same
 *  rule (`internal/store/dashv2.go`), so the two cannot drift into meaning
 *  different things by one filter. */
export interface SessionSummaryFilterAxes {
  harness?: string[];
  status?: string[];
  type?: string[];
  purpose?: string[];
  mode?: string[];
  machine?: string[];
}

/** The axis names, which are also the query parameter names. Iterated rather than
 *  written out at each call site so adding an axis is one edit. */
export const SUMMARY_FILTER_AXES = [
  'harness',
  'status',
  'type',
  'purpose',
  'mode',
  'machine',
] as const satisfies readonly (keyof SessionSummaryFilterAxes)[];

/** True when the filter constrains nothing, so a caller can tell an unfiltered
 *  request from a filtered one without inspecting each axis. */
export function isEmptySummaryFilter(filter: SessionSummaryFilterAxes | undefined): boolean {
  if (!filter) return true;
  return SUMMARY_FILTER_AXES.every((axis) => (filter[axis]?.length ?? 0) === 0);
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

/** `GET /folders` exactly as the gateway sends it (`msg.FolderList`). The field
 *  is literally `folder_order` and its ORDER is the payload — the server keeps a
 *  deliberate folder order and this is the only place it is stated. */
export interface FolderListWire {
  folder_order: string[] | null;
}

/** One content-search hit exactly as log-store sends it (`store.SearchHit`):
 *  the matching session and how many of its events matched. There is no snippet
 *  on the wire — an earlier version of this file declared one, and a `hits` array
 *  wrapped in an envelope, neither of which the backend has ever sent. */
export interface SearchHitWire {
  session_id: string;
  match_count: number;
}

/** One content-search hit, camelCased. `matchCount` is the only ranking signal the
 *  backend offers, so it is carried rather than dropped. */
export interface SearchHit {
  sessionId: string;
  matchCount: number;
}

/** `GET /sessions/search?q=` — the sessions whose materialized transcript text
 *  matches `q`. This is the async augmentation of the instant local name filter:
 *  the client folds `sessionIds` into the search-filter path so a query matches
 *  transcript content, not just the display name.
 *
 *  The server responds with a BARE ARRAY of `SearchHitWire`, not an object. This
 *  type is what `ApiClient.search` returns after mapping that array; it is not the
 *  wire shape. `sessionIds` is ordered by descending `matchCount`. */
export interface SearchResponse {
  sessionIds: string[];
  hits: SearchHit[];
  /** The hit cap this response was fetched under — echoed back so a caller can
   *  report the bound it is subject to without re-deriving it from the request. */
  limit: number;
  /** True when the backend returned a FULL page, i.e. `hits.length === limit`.
   *  The search endpoint reports no total, so a full page is the only evidence
   *  that hits were dropped; there is no way to say how many. Callers must read
   *  this as "at least this many, probably more", never as an exact count. */
  truncated: boolean;
}
