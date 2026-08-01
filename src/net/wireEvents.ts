// The raw SSE/event wire shapes the live-tail reducer consumes. These mirror the
// canonical llm-bridge `msg.Event` JSON (snake_case on the wire, as emitted by
// llm-bridge-server) — deliberately narrow to the fields chat-core reads. The
// materialized, render-ready shapes live in `types.ts`; this file is the *input*
// side (streaming events) that `reduce/TurnReducer.ts` folds into a TurnModel.

/** SSE envelope: `event:`/`data:`/`id:` frame from a bridge event stream. */
export interface WireEvent {
  /** The SSE `id:` line — stringified log-store row id, used for Last-Event-ID resume. */
  id?: string;
  /** The SSE `event:` line; mirrors `data.type` for live events. */
  type: string;
  data: WireEventData;
}

/** Canonical bridge Event payload (the `data` of a WireEvent), narrowed. */
export interface WireEventData {
  /** Injected by log-store on replay; the monotonic row id. */
  event_id?: number;
  type?: string;
  timestamp?: string;
  message_id?: string;
  turn_id?: string;
  harness_message_id?: string;
  client_request_id?: string;

  /** llm-bridge-claudecode tags the OTel copy of a prompt/response here
   *  (`extensions.source = "otel"`) so consumers can tell the two sources apart.
   *  `recovered` marks an assistant text block surfaced from the OTel copy after the
   *  live stream produced nothing that turn (handler.go flushRecoveredAssistant). */
  extensions?: { source?: string; recovered?: boolean };

  stream?: { delta?: { type?: string; text?: string; thinking?: string } };
  block?: {
    block?: {
      type?: string;
      text_block?: { text?: string };
      thinking_block?: { text?: string };
    };
  };
  thinking?: { text?: string; subtype?: string };
  tool_call?: { tool_id?: string; name?: string; input?: unknown };
  tool_result?: { tool_id?: string; name?: string; output?: unknown; is_error?: boolean };
  result?: { text?: string; usage?: unknown; is_error?: boolean };
  // Mirrors the canonical msg.ErrorEvent JSON (snake_case on the wire). `code` values
  // TURN_IDLE_TIMEOUT / PROCESS_DIED are turn terminators; api_error /
  // api_retries_exhausted are informational. `retryable` / `status_code` drive chip styling.
  error?: { code?: string; message?: string; retryable?: boolean; status_code?: number };
  system?: { subtype?: string; message?: string };
  state?: { state?: string; previous?: string; reason?: string };
  info?: unknown;
  hook?: HookEventWire;
}

/** snake_case `msg.HookEvent`, narrowed to the fields the pending-permission surface
 *  reads. A hook whose resolver is out-of-band (a human, usually) emits
 *  `phase="awaiting_resolution"` and parks the tool call until a decision arrives at
 *  `POST /sessions/{id}/hooks/{request_id}/resolve`; the matching `phase="completed"`
 *  carries the same `request_id`. Those two phases are the whole protocol the banner
 *  needs — `started`/`progress` are observation-only.
 *
 *  `source` picks the card: `permission_prompt` (and the empty default) is a tool-gating
 *  ask answered allow/deny; `user_input` is the model asking the human a structured
 *  question, whose answer rides back in the resolve body's `updated_input`. */
export interface HookEventWire {
  event?: string;
  matcher?: string;
  tool_name?: string;
  hook_id?: string;
  source?: string;
  phase?: string;
  request_id?: string;
  /** Raw JSON the harness passed the hook — the tool input, in the harness's own
   *  dialect. Pass-through: chat-core never reshapes it. */
  input?: unknown;
  decision?: string;
}

/** A managed-session row as it arrives on the global list SSE (`/session-events`).
 *  snake_case, as emitted by llm-bridge-server. Projected to SessionSummary by
 *  `summaryFromManaged` in sync/sse.ts. */
export interface ManagedSessionWire {
  session_id: string;
  state?: string;
  harness?: string;
  instance_id?: string;
  type?: string;
  purpose?: string;
  mode?: string;
  folder_name?: string;
  display_name?: string;
  agent_id?: string;
  updated_at?: string;
  created_at?: string;
}

/** snake_case `msg.ToolInfo` — a tool the agent reports (SessionInfoWire.tools[]). */
export interface ToolInfoWire {
  name: string;
  description?: string;
}

/** snake_case `msg.MCPServerInfo` — an MCP server the agent reports. */
export interface McpServerInfoWire {
  name: string;
  status?: string;
}

/** snake_case `msg.SessionInfo` as it rides on a ManagedSession's `info` field
 *  (`GET /sessions/{id}`). Mapped to the camelCase `SessionInfo` by
 *  `ApiClient.getSessionDetail` — this is the single source for that mapping. */
export interface SessionInfoWire {
  system_prompt?: string;
  append_system_prompt?: string;
  working_dir?: string;
  model?: string;
  permission_mode?: string;
  tools?: ToolInfoWire[];
  slash_commands?: string[];
  agents?: string[];
  skills?: string[];
  mcp_servers?: McpServerInfoWire[];
}

/** The raw approval/sandbox knobs carried under `harness_config.permission_mode_custom`
 *  (the power-user "custom" mode escape hatch). Codex consumes `approval` + `sandbox`;
 *  other harnesses define their own subset. snake-free already — these are the leaf
 *  fields of `msg` permissionModeCustomConfig. */
export interface HarnessConfigCustomWire {
  approval?: string;
  sandbox?: string;
}

/** snake_case `harness_config` as it rides on a ManagedSession (`GET /sessions/{id}`).
 *  On the Go side this is an OPAQUE `json.RawMessage` — a per-harness config bag — so
 *  the well-known bridge keys are surfaced explicitly here and the index signature
 *  preserves any harness-specific knob the bridge has not (yet) named. The keys below
 *  are the canonical ones the bridge itself reads/writes (permission_mode.go,
 *  hooks_resolve.go): `permission_mode` (the per-session gate), `disable_network`
 *  (sandbox network gate), `permission_mode_custom` (raw approval/sandbox knobs),
 *  plus `model` / `effort` (per-harness defaults snapshot). Nothing is invented. */
export interface HarnessConfigWire {
  permission_mode?: string;
  disable_network?: boolean;
  permission_mode_custom?: HarnessConfigCustomWire;
  model?: string;
  effort?: string;
  [k: string]: unknown;
}

/** The full per-session detail from `GET /sessions/{id}` — the canonical
 *  ManagedSession (a superset of the list-projection `ManagedSessionWire`) plus the
 *  snake_case `info` blob the summary list omits and the opaque `harness_config` bag. */
export type ManagedSessionDetailWire = ManagedSessionWire & {
  info?: SessionInfoWire | null;
  harness_config?: HarnessConfigWire | null;
};

/** snake_case `msg.HarnessInfo` as returned by `GET /harnesses` — one registered
 *  harness type and its capabilities. Mapped to the camelCase `HarnessMeta` by
 *  `ApiClient.getHarnesses` (the single source of truth for that mapping). This is the
 *  canonical registry the controls bar gates on; the client never hardcodes a
 *  per-harness allowlist. Narrowed to the fields chat-core reads. */
export interface HarnessInfoWire {
  name: string;
  label: string;
  emoji: string;
  tint?: string;
  available: boolean;
  binary?: string;
  /** The feature set the controls bar gates each control on: e.g. `model`, `effort`,
   *  `compact`, `fork`, `system_prompt`, `tools`. */
  capabilities: string[];
  hook_events?: string[];
  /** Provider ids this harness can run models from — scopes the model picker. */
  supported_providers?: string[];
  supported_permission_modes?: string[];
  pty: boolean;
  supports_disable_network?: boolean;
}

/** snake_case model row as returned by `GET /models` (model-store `Model` fields; the
 *  handler embeds credential status too, which chat-core ignores). Projected to the
 *  camelCase `ModelOption` by `ApiClient.getModels`, which also drops `enabled=false`
 *  rows. */
export interface StoreModelWire {
  id: string;
  provider: string;
  name?: string;
  max_tokens?: number;
  input_cost?: number;
  output_cost?: number;
  enabled?: boolean;
}

/** Frame on the global session-list stream (`GET /session-events`). */
export type SessionListFrame =
  | { type: 'hello' }
  | { type: 'upsert'; session: ManagedSessionWire }
  | { type: 'delete'; sessionId: string };
