import { ApiError } from './ApiClient.js';

// The host's reference resolver (dash: `POST /api/resolve`). It classifies
// bare ids found in prose by probing the stores registered in kanban-store's
// entity-type registry, and answers with every store that recognized each id —
// the store's response body passed through unchanged.
//
// This is what lets a chat surface chip a bare uuid without a cue word: the
// text only has to CONTAIN the id, and the resolver — not the phrasing around
// the id — decides what it names. Like NoteboardClient, this client exists for
// ref chips and stays that narrow.

/** One store's answer for an id: which registered entity type matched, which
 *  service answered, and that service's response body verbatim. */
export interface ResolvedRefMatch {
  type: string;
  service: string;
  data: unknown;
}

/** Per-id-and-type failures the resolver reports alongside its results (a
 *  store that answered 5xx, a registry row naming an unmapped service). A
 *  present error means the id's absence from a store is NOT known to be a
 *  miss. */
export interface ResolveRefError {
  id: string;
  type: string;
  error: string;
}

export interface ResolveResponse {
  /** Every requested id is present; an empty array is a definitive miss. */
  results: Record<string, ResolvedRefMatch[]>;
  errors?: ResolveRefError[];
}

export interface ResolveClientConfig {
  fetch: typeof fetch;
  /** The resolver endpoint itself, e.g. dash's '/api/resolve'. */
  endpoint: string;
}

export class ResolveClient {
  private readonly doFetch: typeof fetch;
  readonly endpoint: string;

  constructor(config: ResolveClientConfig) {
    this.doFetch = config.fetch;
    this.endpoint = config.endpoint.replace(/\/$/, '');
  }

  /** Classify a batch of ids in one round-trip. Throws on a non-2xx so a chip
   *  shows "couldn't resolve" rather than silently rendering plain text that
   *  reads as "this id names nothing". */
  async resolve(ids: string[]): Promise<ResolveResponse> {
    const res = await this.doFetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError({
        message: `POST ${this.endpoint} failed: ${res.status} ${res.statusText}`,
        status: res.status,
        body,
        method: 'POST',
        path: this.endpoint,
      });
    }
    return (await res.json()) as ResolveResponse;
  }
}
