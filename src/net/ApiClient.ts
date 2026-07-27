import type {
  MessagesResponse,
  RecentBundleResponse,
  SummaryResponse,
  ValidatorsResponse,
} from './types.js';

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
}
