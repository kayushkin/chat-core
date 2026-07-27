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

## SSE (unchanged from today)
- `GET /session-events` — one global stream of list deltas (`hello`/`upsert`/`delete`).
- `GET /sessions/{id}/events` — per-session stream for the ACTIVE session only; resumes via
  `Last-Event-ID`. Warm-but-inactive sessions are refreshed via validator sweeps, not live
  streams.
