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
export interface Entry {
  id: string; // stable per-entry key (message_id + role, or synthesized from event_id)
  turnId: string; // groups entries into a turn
  role: Role;
  kind: EntryKind;
  source: EntrySource;
  eventId: number; // the log-store event row id — monotonic, used for ordering + resume
  ts: string; // RFC3339 + offset

  // Rendered payload (kind-dependent; unused fields omitted):
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  raw?: unknown; // original event payload, for the raw Timeline view / audit

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

/** The render-ready, fully-annotated model for one session. Holds EVERY entry; the
 *  collapsed Turns view is a pure selector over `entries` (filter !duplicate), the raw
 *  Timeline view renders all of `entries`. */
export interface TurnModel {
  sessionId: string;
  turns: Turn[];
  entries: Record<string, Entry>; // id -> Entry (all sources, all copies)
  validator: Validator;
  more: boolean; // true if older turns exist beyond this page (paginate with `before`)
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
