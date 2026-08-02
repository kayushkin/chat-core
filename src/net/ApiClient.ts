import type {
  HarnessConfig,
  HarnessMeta,
  HookResolveInput,
  ManagedSessionDetail,
  MessagesResponse,
  ModelOption,
  PendingHook,
  RecentBundleResponse,
  SearchHit,
  SearchHitWire,
  SearchResponse,
  SessionConfig,
  SessionInfo,
  SummaryResponse,
  ValidatorsResponse,
} from './types.js';
import type {
  HarnessConfigWire,
  HarnessInfoWire,
  HookEventWire,
  ManagedSessionDetailWire,
  SessionInfoWire,
  StoreModelWire,
} from './wireEvents.js';
import { summaryFromManaged } from '../sync/sse.js';
import { HOOK_PHASE_AWAITING, pendingHookFromWire } from '../store/pendingHooks.js';

/** How many content-search hits to ask `GET /sessions/search` for.
 *
 *  This is the cap log-store has always applied (`handleSearch` defaults `limit`
 *  to 100). It used to apply because the client sent no `limit` at all, so the
 *  bound was the server's fallback rather than anyone's choice, and the client
 *  could not tell a complete result from a truncated one. Sending it explicitly
 *  changes no behaviour and makes `truncated` answerable.
 *
 *  Raising it is NOT free, and the reason is not the request. Measured on this
 *  host 2026-08-02: a broad query matches thousands of sessions (`the` 11,124,
 *  `noteboard` 8,110, `deploy` 3,635), and of a 100-hit page only 8–45 sessions
 *  are in the loaded sidebar window, so 55–92% of hits already render nothing.
 *  Every extra hit is another row the list cannot paint until summaries can be
 *  fetched by id. Raise this together with that fetch, never before it. */
export const SEARCH_HIT_LIMIT = 100;

/** Map the snake_case `msg.SessionInfo` wire blob to the camelCase `SessionInfo`.
 *  The single source of truth for this mapping — every field is copied explicitly
 *  (never spread), so a wire rename fails the type-check here instead of leaking a
 *  snake_case key into the client. Absent fields stay absent; nothing is invented. */
function sessionInfoFromWire(w: SessionInfoWire): SessionInfo {
  return {
    systemPrompt: w.system_prompt,
    appendSystemPrompt: w.append_system_prompt,
    workingDir: w.working_dir,
    model: w.model,
    permissionMode: w.permission_mode,
    tools: w.tools?.map((t) => ({ name: t.name, description: t.description })),
    slashCommands: w.slash_commands,
    agents: w.agents,
    skills: w.skills,
    mcpServers: w.mcp_servers?.map((s) => ({ name: s.name, status: s.status })),
  };
}

/** Map the opaque snake_case `harness_config` bag to the camelCase `HarnessConfig`.
 *  The bridge's well-known keys are copied explicitly (so a wire rename fails the
 *  type-check here); every OTHER key is carried through unchanged — `harness_config`
 *  is opaque on the Go side, and dropping an unnamed knob would make this layer lossy.
 *  Absent well-known fields stay absent; nothing is invented. */
function harnessConfigFromWire(w: HarnessConfigWire): HarnessConfig {
  const {
    permission_mode,
    disable_network,
    permission_mode_custom,
    model,
    effort,
    ...rest
  } = w;
  const cfg: HarnessConfig = { ...rest };
  if (permission_mode !== undefined) cfg.permissionMode = permission_mode;
  if (disable_network !== undefined) cfg.disableNetwork = disable_network;
  if (permission_mode_custom !== undefined) {
    cfg.permissionModeCustom = {
      approval: permission_mode_custom.approval,
      sandbox: permission_mode_custom.sandbox,
    };
  }
  if (model !== undefined) cfg.model = model;
  if (effort !== undefined) cfg.effort = effort;
  return cfg;
}

/** Map the snake_case `msg.HarnessInfo` from `GET /harnesses` to the camelCase
 *  `HarnessMeta`. The single source of truth for this mapping — every field is copied
 *  explicitly (a wire rename fails the type-check here), so no snake_case key leaks into
 *  the client. `capabilities` defaults to `[]` only to keep the type non-optional; the
 *  wire always sends it. Absent optional fields stay absent. */
function harnessMetaFromWire(w: HarnessInfoWire): HarnessMeta {
  return {
    name: w.name,
    label: w.label,
    emoji: w.emoji,
    tint: w.tint,
    available: w.available,
    capabilities: w.capabilities ?? [],
    hookEvents: w.hook_events,
    supportedProviders: w.supported_providers,
    supportedPermissionModes: w.supported_permission_modes,
    pty: w.pty,
    supportsDisableNetwork: w.supports_disable_network,
  };
}

/** Project a snake_case `GET /models` row to the controls-bar `ModelOption`. `value` is
 *  the model id the config POST sends; `label` mirrors bridge-ui's `name ($in/$out)`
 *  format, falling back to just the name (or id) when cost is not reported — never
 *  fabricating a cost. */
function modelOptionFromWire(w: StoreModelWire): ModelOption {
  const name = w.name || w.id;
  const label =
    typeof w.input_cost === 'number' && typeof w.output_cost === 'number'
      ? `${name} ($${w.input_cost}/$${w.output_cost})`
      : name;
  return { value: w.id, label, provider: w.provider };
}

/** Project a create/fork response (the canonical snake_case `msg.ManagedSession`) to a
 *  `CreatedSession`. The wire id field is `session_id` — read it from the CANONICAL key
 *  (never a `sessionId` that these endpoints don't emit) and surface it camelCase, while
 *  carrying the rest of the payload through unchanged. */
function createdSessionFromWire(w: Record<string, unknown>): CreatedSession {
  const sessionId = typeof w['session_id'] === 'string' ? (w['session_id'] as string) : '';
  return { ...w, sessionId };
}

/** The error every non-2xx response throws.
 *
 *  It carries the HTTP status and the raw response body alongside the message,
 *  because some refusals mean something specific and a caller has to be able to
 *  tell them apart. The spend-ceiling gate is the one that forced this: the
 *  server refuses a send with a 402 whose JSON body names both dollar figures
 *  (`internal/server/sessions.go` `writeRefusalIfOverBudget`), and the only way
 *  to read those figures used to be to pick the JSON back out of the English
 *  message string — which is guessing, not reading.
 *
 *  `message` keeps the exact text it always had, so anything already rendering
 *  `e.message` is unchanged.
 *
 *  `body` is the response text, empty when the body could not be read. It is
 *  passed through unchanged: no parsing, no truncation — the layer that knows
 *  what shape to expect does the parsing. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** HTTP status of the refused response. */
  readonly status: number;
  /** The response body verbatim, or '' when it could not be read. */
  readonly body: string;
  /** The request method, e.g. 'POST'. */
  readonly method: string;
  /** The path under `basePath`, e.g. '/sessions/br_1/send'. */
  readonly path: string;

  constructor(init: { message: string; status: number; body: string; method: string; path: string }) {
    super(init.message);
    this.status = init.status;
    this.body = init.body;
    this.method = init.method;
    this.path = init.path;
  }
}

/** The auth'd fetch + API root the client speaks through. dash passes its
 *  cookie-credentialed `apiFetch` and `basePath = '/api/bridge'`. */
export interface ApiClientConfig {
  fetch: typeof fetch;
  basePath: string;
}

/** Mutation response from POST /sessions and POST /sessions/{id}/send etc. */
export interface CreatedSession {
  sessionId: string;
  [k: string]: unknown;
}

export interface SendResult {
  messageId?: string;
}

/**
 * Typed wrapper over the additive dashv2 endpoints (§5 of the architecture doc)
 * plus the existing bridge mutation endpoints. Every method is a thin, honest
 * pass-through — no formatting or fallback: it returns exactly what the backend
 * sends, and throws loudly on a non-2xx so callers can revert optimistic state.
 */
export class ApiClient {
  private readonly doFetch: typeof fetch;
  readonly basePath: string;

  constructor(config: ApiClientConfig) {
    this.doFetch = config.fetch;
    this.basePath = config.basePath.replace(/\/$/, '');
  }

  /** The auth'd fetch, for the SSE transport (which streams rather than
   *  awaiting JSON). Same credentialed function the read/mutation methods use. */
  fetchFor(): typeof fetch {
    return this.doFetch;
  }

  private async getJSON<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.doFetch(`${this.basePath}${path}`, init);
    if (!res.ok) {
      // GET refusals never carried their body in the message and still don't;
      // reading it here would change nothing a caller sees. It is read onto the
      // ApiError all the same, so a future caller that needs it has it.
      const body = await res.text().catch(() => '');
      throw new ApiError({
        message: `GET ${path} failed: ${res.status} ${res.statusText}`,
        status: res.status,
        body,
        method: 'GET',
        path,
      });
    }
    return (await res.json()) as T;
  }

  private async postJSON<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.basePath}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ApiError({
        message: `POST ${path} failed: ${res.status} ${res.statusText} ${detail}`.trim(),
        status: res.status,
        body: detail,
        method: 'POST',
        path,
      });
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  private async putJSON<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.basePath}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ApiError({
        message: `PUT ${path} failed: ${res.status} ${res.statusText} ${detail}`.trim(),
        status: res.status,
        body: detail,
        method: 'PUT',
        path,
      });
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  // --- dashv2 read endpoints ---

  /** Projected sidebar list, newest first, paginated. */
  getSummary(opts?: { limit?: number; before?: string }): Promise<SummaryResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.before) params.set('before', opts.before);
    const qs = params.toString();
    return this.getJSON<SummaryResponse>(`/sessions/summary${qs ? `?${qs}` : ''}`);
  }

  /** The N most-recent sessions, each with summary + materialized turns, in one trip. */
  getRecentBundle(opts?: { n?: number; turns?: number }): Promise<RecentBundleResponse> {
    const params = new URLSearchParams();
    if (opts?.n != null) params.set('n', String(opts.n));
    if (opts?.turns != null) params.set('turns', String(opts.turns));
    const qs = params.toString();
    return this.getJSON<RecentBundleResponse>(`/sessions/recent-bundle${qs ? `?${qs}` : ''}`);
  }

  /** The cheap staleness check for a set of session ids. */
  getValidators(ids: string[]): Promise<ValidatorsResponse> {
    if (ids.length === 0) return Promise.resolve({});
    const qs = new URLSearchParams({ ids: ids.join(',') }).toString();
    return this.getJSON<ValidatorsResponse>(`/sessions/validators?${qs}`);
  }

  /** The server's own default turn count for the bounded shape, mirrored here
   *  so a caller that names no limit still asks for the same window. */
  static readonly DEFAULT_MESSAGE_TURNS = 30;

  /**
   * Materialized tail (or a page older than `before`) for one session.
   *
   * A limit always goes on the wire, even when the caller names none. That
   * endpoint serves two shapes off the same path: with `limit` or `before` it
   * answers the bounded `{ model }` this method is typed for, and with neither
   * it answers the legacy unbounded array — every event in the session, which
   * reached 306MB and 52s for one real session on this box. Omitting the
   * parameter would therefore return a body that does not match
   * `MessagesResponse` at all, and `resp.model` would read as undefined with
   * no error anywhere. There is no case where this client wants that shape.
   */
  getMessages(id: string, opts?: { limit?: number; before?: string | number }): Promise<MessagesResponse> {
    const params = new URLSearchParams();
    params.set('limit', String(opts?.limit ?? ApiClient.DEFAULT_MESSAGE_TURNS));
    if (opts?.before != null) params.set('before', String(opts.before));
    return this.getJSON<MessagesResponse>(`/sessions/${id}/messages?${params.toString()}`);
  }

  /** Full-text content search across session transcripts. Returns the matching
   *  session ids so the list/filter path can fold content hits in alongside the
   *  instant local name match. Async augmentation only — the caller must NOT block
   *  the local name filter on this. Throws loudly on a non-2xx.
   *
   *  The endpoint answers with a BARE ARRAY of `{session_id, match_count}`. This
   *  used to be read as `SearchResponse.sessionIds`, a property a JSON array does
   *  not have: the result was `undefined`, `new Set(undefined)` produced an empty
   *  set without throwing, and content search silently matched nothing for every
   *  query while the display-name filter went on working. Map the real shape here,
   *  at the wire edge, and fail loudly if it is not the array the backend promises. */
  async search(q: string, opts?: { limit?: number }): Promise<SearchResponse> {
    const limit = opts?.limit ?? SEARCH_HIT_LIMIT;
    const qs = new URLSearchParams({ q, limit: String(limit) }).toString();
    const wire = await this.getJSON<SearchHitWire[]>(`/sessions/search?${qs}`);
    if (!Array.isArray(wire)) {
      throw new Error(
        `GET /sessions/search returned ${typeof wire}, expected an array of {session_id, match_count}`,
      );
    }
    const hits: SearchHit[] = wire
      .map((h) => ({ sessionId: h.session_id, matchCount: h.match_count }))
      .sort((a, b) => b.matchCount - a.matchCount);
    return {
      sessionIds: hits.map((h) => h.sessionId),
      hits,
      limit,
      truncated: hits.length >= limit,
    };
  }

  /** Full per-session detail (`GET /sessions/{id}`) — the canonical ManagedSession,
   *  with its snake_case `info` mapped to a camelCase `SessionInfo`. This endpoint
   *  already exists and is live; the summary list deliberately omits `info`, so this
   *  is the lazy fetch that backs `useSessionInfo`. `info` is null when the harness
   *  has not reported one yet. Throws loudly on a non-2xx (getJSON). */
  async getSessionDetail(id: string): Promise<ManagedSessionDetail> {
    const wire = await this.getJSON<ManagedSessionDetailWire>(`/sessions/${id}`);
    const summary = summaryFromManaged(wire);
    return {
      sessionId: summary.sessionId,
      summary,
      info: wire.info ? sessionInfoFromWire(wire.info) : null,
      harnessConfig: wire.harness_config ? harnessConfigFromWire(wire.harness_config) : null,
    };
  }

  // --- mutations (existing bridge endpoints; see bridge-ui useBridgeSession.ts) ---

  async createSession(opts?: { instanceId?: string; harness?: string }): Promise<CreatedSession> {
    const wire = await this.postJSON<Record<string, unknown>>('/sessions', {
      type: 'interactive',
      purpose: 'chat',
      origin: 'frontend',
      ...(opts?.instanceId ? { instance_id: opts.instanceId } : {}),
      ...(opts?.harness ? { harness: opts.harness } : {}),
    });
    // POST /sessions returns the canonical `msg.ManagedSession` (snake_case) — its id
    // field is `session_id`, so read it from the canonical key rather than assuming a
    // `sessionId` these endpoints never emit.
    return createdSessionFromWire(wire);
  }

  send(id: string, text: string): Promise<SendResult> {
    return this.postJSON<SendResult>(`/sessions/${id}/send`, { message: text });
  }

  /**
   * Compact a session's context. POST /sessions/{id}/compact — body `{ summary }` when a
   * caller supplies a compaction summary, else `{}`. LOUD: `postJSON` throws on any
   * non-2xx. The POST only ACKNOWLEDGES the request (a `compact_ack` system event);
   * compaction runs async and its real completion is the `compact_boundary` system entry
   * on the session's event stream — `useSessionControls` watches for that, never faking a
   * done state.
   * (bridge-ui: useBridgeSession.ts:1129.)
   */
  compact(id: string, summary?: string): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/compact`, summary ? { summary } : {});
  }

  /**
   * Fork a session into a new sibling. POST /sessions/{id}/fork — body
   * `{ display_name, type: 'interactive' }` (empty display name lets the server derive
   * "<parent> (fork)"). Returns the new `CreatedSession`, its id read from the canonical
   * `session_id` wire key. LOUD: throws on any non-2xx (e.g. the 409 the server returns
   * when the parent has no `harness_session_id` yet).
   * (bridge-ui: useBridgeSession.ts:1143.)
   */
  async fork(id: string, displayName?: string): Promise<CreatedSession> {
    const wire = await this.postJSON<Record<string, unknown>>(`/sessions/${id}/fork`, {
      display_name: displayName ?? '',
      type: 'interactive',
    });
    return createdSessionFromWire(wire);
  }

  /**
   * Switch a live session between events and pty I/O mode. POST /sessions/{id}/mode with
   * body `{ mode }` (`'events' | 'pty'`). The server kills and respawns the harness via
   * --resume so history is preserved. Returns the raw response (which carries an
   * `attach_token` for a pty switch); pty attach-token management is a bridge-ui concern,
   * so chat-core passes the payload through unchanged. LOUD: throws on any non-2xx.
   * (bridge-ui: useBridgeSession.ts:973.)
   */
  switchMode(id: string, mode: 'events' | 'pty'): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/mode`, { mode });
  }

  /**
   * Apply per-session config knobs. POST /sessions/{id}/config with the snake_case body
   * `{ model?, effort?, max_budget?, disabled_tools? }` — only the provided fields are
   * sent (an absent field is never serialized as null). This is the canonical path
   * bridge-ui uses for BOTH the controls-bar model/effort pre-start settings (applied
   * right after create) and changing them on a live session. LOUD: throws on any non-2xx.
   * (bridge-ui: useBridgeSession.ts:1176.)
   */
  setConfig(id: string, config: SessionConfig): Promise<unknown> {
    const body: Record<string, unknown> = {};
    if (config.model !== undefined) body.model = config.model;
    if (config.effort !== undefined) body.effort = config.effort;
    if (config.maxBudget !== undefined) body.max_budget = config.maxBudget;
    if (config.disabledTools !== undefined) body.disabled_tools = config.disabledTools;
    return this.postJSON(`/sessions/${id}/config`, body);
  }

  /**
   * The registered harness types and their capabilities. GET /harnesses — the CANONICAL
   * registry the controls bar gates each control on (`capabilities`) and scopes the model
   * picker with (`supportedProviders`). Mapped snake_case → camelCase per harness. LOUD:
   * throws on any non-2xx. (bridge-ui reads the same endpoint: BridgeChat.tsx:304.)
   */
  async getHarnesses(): Promise<HarnessMeta[]> {
    const wire = await this.getJSON<HarnessInfoWire[] | null>('/harnesses');
    // A nil Go slice serializes as JSON `null`; treat any non-array as empty.
    return Array.isArray(wire) ? wire.map(harnessMetaFromWire) : [];
  }

  /**
   * The available models for the controls-bar picker. GET /models — the canonical
   * model-store registry. Drops `enabled=false` rows (mirroring bridge-ui) and projects
   * each to a `ModelOption` carrying `provider` so `useModels` can filter by a harness's
   * supported providers. LOUD: throws on any non-2xx. (bridge-ui: BridgeChat.tsx:260.)
   */
  async getModels(): Promise<ModelOption[]> {
    const wire = await this.getJSON<StoreModelWire[] | null>('/models');
    // A nil Go slice serializes as JSON `null`; treat any non-array as empty.
    return Array.isArray(wire) ? wire.filter((m) => m.enabled).map(modelOptionFromWire) : [];
  }

  rename(id: string, displayName: string): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/rename`, { display_name: displayName });
  }

  /**
   * Mark a session done (or undo it).
   *
   * `done: true` sets state=completed and moves the session into the canonical
   * `Archive` folder; `done: false` reverses both. The two halves are ONE atomic
   * action server-side (`handleMarkSessionDone`), which is why there is a single
   * route taking a boolean rather than an archive/unarchive pair.
   *
   * This replaces `archive()` / `unarchive()`, which POSTed to
   * `/sessions/{id}/archive` and `/sessions/{id}/unarchive`. Neither route has ever
   * existed: the gateway registers `PUT /sessions/{id}/folder` and
   * `POST /sessions/{id}/mark-done`, and "unarchive" appears in no Go source at all.
   * Probed live 2026-08-02 against one session id — archive 404, unarchive 404,
   * mark-done 204.
   */
  markSessionDone(id: string, done: boolean): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/mark-done`, { done });
  }

  resume(id: string): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/resume`, {});
  }

  /**
   * Interrupt/stop a running session's current turn.
   * POST /sessions/{id}/interrupt.
   *
   * This is deliberately a LOUD call: `postJSON` throws on any non-2xx, and this
   * method keeps that. The server returns 409 ("nothing was stopped") while a tool
   * still holds the turn (until the server-side gate fix ships) — that MUST surface
   * as a thrown error so the caller does NOT optimistically mark the session idle.
   * Never swallow this into a fake-idle.
   */
  interrupt(id: string): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/interrupt`, {});
  }

  /**
   * Set a session's per-session permission mode.
   * PUT /sessions/{id}/permission-mode with body `{ mode }`.
   *
   * The bridge persists this into `harness_config.permission_mode`; the prehook
   * reads it live, so the change takes effect on the session's NEXT tool call
   * without a restart. `mode` is one of the canonical `msg.PermissionMode*` values
   * (ask / auto / bypass / plan / read / ask_all / block_all / custom) — validated
   * server-side. This is a LOUD call: `putJSON` throws on any non-2xx (e.g. 400 on an
   * invalid mode, 404 on an unknown session), so an optimistic UI update can revert.
   */
  setPermissionMode(id: string, mode: string): Promise<unknown> {
    return this.putJSON(`/sessions/${id}/permission-mode`, { mode });
  }

  // --- parked hooks (the permission banner) ---

  /**
   * The hooks this session has parked on a human decision.
   * GET /sessions/{id}/hooks/pending.
   *
   * The server answers with whole `msg.Event`s, so the hook rides under `.hook`; this
   * unwraps and camelCases them, and keeps only `awaiting_resolution` entries that carry
   * a request id — the rest cannot be resolved and would be a card with no button.
   *
   * Hydration matters because the session SSE resumes from Last-Event-ID, and a hook
   * parked before the client attached is a tool call frozen with nothing on screen.
   */
  async getPendingHooks(id: string): Promise<PendingHook[]> {
    const events = await this.getJSON<Array<{ hook?: HookEventWire }>>(
      `/sessions/${id}/hooks/pending`,
    );
    if (!Array.isArray(events)) return [];
    const out: PendingHook[] = [];
    for (const ev of events) {
      const hook = pendingHookFromWire(ev?.hook);
      if (hook && hook.phase === HOOK_PHASE_AWAITING) out.push(hook);
    }
    return out;
  }

  /**
   * Deliver a decision for a parked hook.
   * POST /sessions/{id}/hooks/{request_id}/resolve.
   *
   * LOUD, like every other mutation here: `postJSON` throws on a non-2xx so the caller
   * restores the card instead of leaving the user believing a frozen tool call was
   * answered. `updatedInput` replaces the tool input wholesale (how a `user_input`
   * hook's answers reach the model) and is omitted when absent — never sent as null.
   */
  resolveHook(id: string, input: HookResolveInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      behavior: input.behavior,
      resolved_by: input.resolvedBy || 'user',
    };
    if (input.updatedInput !== undefined) body.updated_input = input.updatedInput;
    if (input.message) body.message = input.message;
    return this.postJSON(
      `/sessions/${id}/hooks/${encodeURIComponent(input.requestId)}/resolve`,
      body,
    );
  }
}
