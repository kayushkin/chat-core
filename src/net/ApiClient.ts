import type {
  ManagedSessionDetail,
  MessagesResponse,
  RecentBundleResponse,
  SearchResponse,
  SessionInfo,
  SummaryResponse,
  ValidatorsResponse,
} from './types.js';
import type { ManagedSessionDetailWire, SessionInfoWire } from './wireEvents.js';
import { summaryFromManaged } from '../sync/sse.js';

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
      throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
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
      throw new Error(`POST ${path} failed: ${res.status} ${res.statusText} ${detail}`.trim());
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

  /** Materialized tail (or a page older than `before`) for one session. */
  getMessages(id: string, opts?: { limit?: number; before?: string | number }): Promise<MessagesResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.before != null) params.set('before', String(opts.before));
    const qs = params.toString();
    return this.getJSON<MessagesResponse>(`/sessions/${id}/messages${qs ? `?${qs}` : ''}`);
  }

  /** Full-text content search across session transcripts. Returns the matching
   *  session ids so the list/filter path can fold content hits in alongside the
   *  instant local name match. Async augmentation only — the caller must NOT block
   *  the local name filter on this. Throws loudly on a non-2xx. */
  search(q: string): Promise<SearchResponse> {
    const qs = new URLSearchParams({ q }).toString();
    return this.getJSON<SearchResponse>(`/sessions/search?${qs}`);
  }

  /** Full per-session detail (`GET /sessions/{id}`) — the canonical ManagedSession,
   *  with its snake_case `info` mapped to a camelCase `SessionInfo`. This endpoint
   *  already exists and is live; the summary list deliberately omits `info`, so this
   *  is the lazy fetch that backs `useSessionInfo`. `info` is null when the harness
   *  has not reported one yet. Throws loudly on a non-2xx (getJSON). */
  async getSessionDetail(id: string): Promise<ManagedSessionDetail> {
    const wire = await this.getJSON<ManagedSessionDetailWire>(`/sessions/${id}`);
    return {
      summary: summaryFromManaged(wire),
      info: wire.info ? sessionInfoFromWire(wire.info) : null,
    };
  }

  // --- mutations (existing bridge endpoints; see bridge-ui useBridgeSession.ts) ---

  createSession(opts?: { instanceId?: string; harness?: string }): Promise<CreatedSession> {
    return this.postJSON<CreatedSession>('/sessions', {
      type: 'interactive',
      purpose: 'chat',
      origin: 'frontend',
      ...(opts?.instanceId ? { instance_id: opts.instanceId } : {}),
      ...(opts?.harness ? { harness: opts.harness } : {}),
    });
  }

  send(id: string, text: string): Promise<SendResult> {
    return this.postJSON<SendResult>(`/sessions/${id}/send`, { message: text });
  }

  rename(id: string, displayName: string): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/rename`, { display_name: displayName });
  }

  archive(id: string): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/archive`, {});
  }

  unarchive(id: string): Promise<unknown> {
    return this.postJSON(`/sessions/${id}/unarchive`, {});
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
}
