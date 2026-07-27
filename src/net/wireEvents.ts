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
   *  (`extensions.source = "otel"`) so consumers can tell the two sources apart. */
  extensions?: { source?: string };

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
  error?: { message?: string };
  system?: { subtype?: string; message?: string };
  state?: { state?: string; previous?: string; reason?: string };
  info?: unknown;
  hook?: { request_id?: string; phase?: string };
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

/** Frame on the global session-list stream (`GET /session-events`). */
export type SessionListFrame =
  | { type: 'hello' }
  | { type: 'upsert'; session: ManagedSessionWire }
  | { type: 'delete'; sessionId: string };
