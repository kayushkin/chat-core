# chat-core wire contract

Authoritative shape of the traffic between the Go backend (llm-bridge-server `:8160` +
log-store `:8175`) and this client. The TypeScript source of truth is `src/net/types.ts`;
the Go structs must serialize to exactly these JSON shapes. Keep both in lockstep.

## Conventions
- Timestamps: RFC3339 **with offset** (e.g. `2026-07-27T14:03:11-07:00`). Never naive.
- JSON field names: camelCase on the wire (Go structs use `json:"sessionId"` tags).
- All responses are gzip/br-compressed by nginx (SSE excluded). Handlers write plain JSON.
- Nothing is lossy. Dedup is expressed as annotation on `Entry` (`duplicate`, `primary`,
  `groupId`), never by omitting an event. The raw Timeline view must be able to reconstruct
  every stored event from the payload.

## Endpoints (all additive; existing endpoints unchanged)

### `GET /sessions/summary?limit=100&before=<cursor>`
Projected sidebar list, newest first, paginated. Omits `info` / `harness_config`.
→ `SummaryResponse` `{ sessions: SessionSummary[], next: string|null, revision: string }`.
Also sets `ETag: <revision>`; honors `If-None-Match` → `304`.
`revision` = max(updatedAt) across the table (or a monotonic change counter).

### `GET /sessions/recent-bundle?n=20&turns=30`
The N most-recent sessions, each with summary + last `turns` turns materialized, in ONE
response. → `RecentBundleResponse` `{ [sessionId]: { summary, model } }`.
Server-assembled and response-cached (keyed by the max updatedAt across the N), invalidated
by the store mutation Notifier.

### `GET /sessions/validators?ids=a,b,c`
→ `ValidatorsResponse` `{ [sessionId]: { maxEventId, eventCount, updatedAt } }`.
The cheap staleness check: a cached model is fresh iff its validator matches.

### `GET /sessions/{id}/messages?limit=30&before=<eventId>`
Materialized tail (or a page older than `before`). → `MessagesResponse { model }`.
`model.more=true` if older turns remain. Never unbounded — default returns the last `limit`
turns only.

### `GET /sessions/search?q=<text>`
Full-text content search across session transcripts. → `SearchResponse`
`{ sessionIds: string[], hits?: { sessionId, snippet? }[] }` — the ids whose materialized
transcript text matched `q`. The client folds `sessionIds` into the search-filter path
(C6) so a query matches transcript content, not just the display name. This is an ASYNC
AUGMENTATION of the instant local name filter — the client never blocks name-matching on
it, and a response for a superseded query is dropped (the hit set is pinned to its query).

### `POST /sessions/{id}/interrupt`
Interrupt/stop the running turn. The client treats this as a LOUD call: any non-2xx throws
and MUST surface (never a swallowed fake-idle). In particular the server returns **409**
("nothing was stopped") while a tool still holds the turn — until the server-side gate fix
ships — and the client must show that, not optimistically mark the session idle.

### `GET /sessions/{id}`
The full per-session detail — the canonical `msg.ManagedSession` (snake_case). Unlike the
summary list it carries the heavy `info` blob. The client (`ApiClient.getSessionDetail`)
projects the summary fields via `summaryFromManaged` and maps the snake_case `info` →
camelCase `SessionInfo`; `info` is `null` when the harness has reported none yet. Backs
`useSessionInfo` (lazy, cached per id). The wire `info` is `msg.SessionInfo`:

| wire (snake_case, `msg.SessionInfo`) | client (`SessionInfo`, camelCase) |
| --- | --- |
| `system_prompt` | `systemPrompt?` |
| `append_system_prompt` | `appendSystemPrompt?` |
| `working_dir` | `workingDir?` |
| `model` | `model?` |
| `permission_mode` | `permissionMode?` |
| `tools[]` `{name, description?}` (`msg.ToolInfo`) | `tools?: { name; description? }[]` (`ToolInfo`) |
| `slash_commands[]` | `slashCommands?` |
| `agents[]` | `agents?` |
| `skills[]` | `skills?` |
| `mcp_servers[]` `{name, status?}` (`msg.MCPServerInfo`) | `mcpServers?: { name; status? }[]` (`McpServerInfo`) |

Every info field is copied explicitly (never spread) so a wire rename fails the type-check at
the mapping site instead of leaking a snake_case key through.

The detail also carries the session's `harness_config` bag, which the summary list omits.
On the Go side `ManagedSession.HarnessConfig` is an **opaque `json.RawMessage`** — a
per-harness config map — so `getSessionDetail` surfaces the bridge's own well-known keys in
camelCase (`harnessConfigFromWire`) and passes every OTHER key through unchanged (the index
signature on `HarnessConfig`), keeping the layer lossless. `harnessConfig` is `null` when the
wire omits `harness_config`. The well-known keys are the ones the bridge itself reads/writes
(llm-bridge-server `permission_mode.go`, `hooks_resolve.go`):

| wire (snake_case, `harness_config`) | client (`HarnessConfig`, camelCase) |
| --- | --- |
| `permission_mode` | `permissionMode?` |
| `disable_network` | `disableNetwork?` |
| `permission_mode_custom` `{approval?, sandbox?}` | `permissionModeCustom?: { approval?; sandbox? }` (`HarnessConfigCustom`) |
| `model` | `model?` |
| `effort` | `effort?` |
| *(any other key)* | *(carried through unchanged — opaque bag)* |

`ManagedSessionDetail` is `{ sessionId, summary, info, harnessConfig }` — `sessionId` is
surfaced at the top level (it also lives on `summary`). `useManagedSession` reads this; the
interactive permission-mode selector reads `harnessConfig.permissionMode`.

### `PUT /sessions/{id}/permission-mode`
Set a session's per-session permission mode. Body `{ "mode": "<PermissionMode>" }` where
mode ∈ ask | auto | bypass | plan | read | ask_all | block_all | custom (validated
server-side → 400 on an invalid value; 404 on an unknown session). The bridge persists it
into `harness_config.permission_mode`; the prehook reads it **live**, so the change takes
effect on the session's NEXT tool call without a restart. `ApiClient.setPermissionMode` treats
this as a LOUD call (throws on any non-2xx) so `useManagedSession`'s optimistic cache update
can revert. (The server also accepts optional `disable_network` and `permission_mode_custom`
fields on this PUT; the client currently sends only `mode` per the required signature.)

## Cost / context: `Entry.usage` + `TurnModel.aggregates` (Phase 2)
These ride on the materialized model from `GET /sessions/{id}/messages`, populated by
log-store's spend/context materializer. Unlike `SessionInfo` they are **camelCase already on
the wire** — no client mapping — so the TS shapes below ARE the wire shapes. Both MAY be
absent; absence reads as zero, never a fabricated figure.

- `Entry.usage?` — per-entry token usage, mirrored 1:1 from the source event's
  `msg.TokenUsage`. Absent on events with no usage (user_message, most system entries). Read
  by the UI directly off the entry; there is no per-entry hook.
  ```
  usage?: { inputTokens?; outputTokens?; cacheReadTokens?; cacheWriteTokens? }
  ```
  Provenance: `msg.TokenUsage` (`InputTokens` / `OutputTokens` / `CacheReadTokens` /
  `CacheWriteTokens`). On the materialized model the field is emitted camelCase per the
  convention above — no client mapping.
- `TurnModel.aggregates?` — the loaded page's cost/context roll-up. **Undefined when the
  spend/context events fall outside the loaded page.** `useSessionCost` and `useContextUsage`
  read from here and return zeros when it (or a member) is absent.
  ```
  aggregates?: {
    totalUsd?;                          // APISpendTotalEvent.TotalUSD
    byModel?: Record<string, number>;   // APISpendTotalEvent.ByModel
    byQuerySource?: Record<string, number>; // APISpendTotalEvent.ByQuerySource
    contextTokens?; contextLimit?;      // context-window figures; pct = tokens/limit*100
  }
  ```
  Emitted camelCase on the materialized wire (no client mapping); the `msg` names are
  provenance for the canonical source of each figure.

## The `Entry` / dedup model (non-destructive)
Every stored event → exactly one `Entry`. Materialization on the server (log-store
`materialize.go`) groups entries into turns and sets the annotations:
- `duplicate`: hidden in the collapsed Turns view; ALWAYS shown in the raw Timeline view.
- `primary`: the single copy shown for its `groupId` in the collapsed view.
- `groupId`: entries with identical logical content across sources share this (e.g. the
  harness assistant text and its ~1s-late OTel copy). The per-message "sources" badge counts
  a group's members and lists their `source`.

Dedup is **source+count**, never positional (the OTel copy can arrive after the reply). The
client keeps this logic for the LIVE TAIL only (`reduce/otelDedup.ts`); the server owns it
for settled history. A shared fixture (including a 1s-late dual-emit case) pins both to the
same output.

### OTel / error / system `Entry` fields (mapped from the canonical wire)
These optional fields ride on `Entry` (camelCase), mapped 1:1 from the source event —
never invented. log-store's `Entry` struct and the live-tail reducer populate the same set.
- `recovered?: boolean` — an assistant text block surfaced from the OTel copy after the live
  stream produced nothing that turn (`extensions.recovered`; handler.go
  `flushRecoveredAssistant`). It is NOT a duplicate — there is no live copy to collapse it
  against, so it renders as the assistant message. The flag is a presentation marker only and
  never gates visibility. On the settled path such a block is kept **visible/primary** when no
  Result or harness assistant text supersedes it in the same turn.
- `code?: string`, `retryable?: boolean`, `statusCode?: number` — the canonical
  `msg.ErrorEvent{Code,Message,Retryable,StatusCode}` fields on a kind `'error'` entry (wire:
  `error.code` / `error.retryable` / `error.status_code`). `code` values `TURN_IDLE_TIMEOUT` and
  `PROCESS_DIED` are **turn terminators** (transition the session out of running/holding);
  `api_error` / `api_retries_exhausted` are **informational** chips and must NOT clear the
  running state. Unknown codes render generically.
- `subtype?: string` — the `SystemEvent.subtype` on a kind `'system'` entry (e.g.
  `subagent_completed`, `compact_boundary`). An unknown subtype renders generically, never as
  an error.

### Client terminal-state reconcile (F1)
The server's `sessions.state` can stay pinned to a holding value (`tool_running`) after a turn
actually settled. `reduce/terminalState.ts` `terminalStateFromTail(model)` scans the
materialized tail for a terminal signal — a kind `'result'` entry, a kind `'error'` entry whose
`code` is `TURN_IDLE_TIMEOUT`/`PROCESS_DIED`, or a raw event `type` in
`{turn_complete, close, result}` — and the `effectiveState` selector overrides a stale
running/holding summary state with the tail's verdict (`completed`/`failed`). Content was never
missing; only the displayed state is corrected.

## SSE (unchanged from today)
- `GET /session-events` — one global stream of list deltas (`hello`/`upsert`/`delete`).
- `GET /sessions/{id}/events` — per-session stream for the ACTIVE session only; resumes via
  `Last-Event-ID`. Warm-but-inactive sessions are refreshed via validator sweeps, not live
  streams.
