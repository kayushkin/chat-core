import type { SessionSummary } from '../net/types.js';
import type {
  ManagedSessionWire,
  SessionListFrame,
  WireEvent,
  WireEventData,
} from '../net/wireEvents.js';

// SSE transport (decision D6). Fetch + ReadableStream (not native EventSource) so
// we get auth'd headers and Last-Event-ID resume. Two entrypoints, mirroring the
// two-stream model: one global list stream + one per-session stream for the
// ACTIVE session only. Ported from bridge-ui `bridgeSSE.ts` — same framing, same
// backend streams (`GET /session-events`, `GET /sessions/{id}/events`).

interface SSEFrame {
  type: string;
  data: string;
  id?: string;
}

async function* readFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: SSEFrame = { type: '', data: '' };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          if (current.data || current.type) yield current;
          current = { type: '', data: '' };
        } else if (line.startsWith('event:')) {
          current.type = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          current.data += (current.data ? '\n' : '') + line.slice(5).trim();
        } else if (line.startsWith('id:')) {
          current.id = line.slice(3).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Connect a per-session event stream. Resumes from `lastEventId` via the
 *  `Last-Event-ID` header so a reconnect misses nothing. */
export async function* connectSessionSSE(
  fetchFn: typeof fetch,
  basePath: string,
  sessionId: string,
  lastEventId?: string,
  signal?: AbortSignal,
): AsyncGenerator<WireEvent> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;

  const res = await fetchFn(`${basePath}/sessions/${sessionId}/events`, { headers, signal });
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('No response body');

  for await (const frame of readFrames(res.body)) {
    if (!frame.data) continue;
    let data: WireEventData;
    try {
      data = JSON.parse(frame.data) as WireEventData;
    } catch {
      continue; // skip unparseable frames
    }
    if (frame.id) {
      yield { id: frame.id, type: frame.type || data.type || 'message', data };
    } else {
      yield { type: frame.type || data.type || 'message', data };
    }
  }
}

function summaryFromManaged(m: ManagedSessionWire): SessionSummary {
  return {
    sessionId: m.session_id,
    state: m.state ?? '',
    harness: m.harness ?? '',
    instanceId: m.instance_id ?? '',
    type: m.type ?? '',
    purpose: m.purpose ?? '',
    mode: m.mode ?? '',
    folderName: m.folder_name ?? '',
    displayName: m.display_name ?? '',
    agentId: m.agent_id ?? '',
    updatedAt: m.updated_at ?? '',
    createdAt: m.created_at ?? '',
    harnessSessionId: m.harness_session_id ?? '',
    managerSessionId: m.manager_session_id ?? '',
  };
}

/** Connect the global session-list stream. Yields normalized frames
 *  (`hello` / `upsert` / `delete`); upserts carry a projected SessionSummary. */
export async function* connectListSSE(
  fetchFn: typeof fetch,
  basePath: string,
  signal?: AbortSignal,
): AsyncGenerator<SessionListFrame & { summary?: SessionSummary }> {
  const res = await fetchFn(`${basePath}/session-events`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok) throw new Error(`list SSE connect failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('No response body');

  for await (const frame of readFrames(res.body)) {
    let data: Record<string, unknown> = {};
    if (frame.data) {
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    if (frame.type === 'hello') {
      yield { type: 'hello' };
    } else if (frame.type === 'upsert' && data.session) {
      const wire = data.session as ManagedSessionWire;
      yield { type: 'upsert', session: wire, summary: summaryFromManaged(wire) };
    } else if (frame.type === 'delete' && data.session_id) {
      yield { type: 'delete', sessionId: String(data.session_id) };
    }
  }
}

export { summaryFromManaged };
