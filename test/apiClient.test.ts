import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/net/ApiClient.js';

interface FakeRes {
  ok: boolean;
  status: number;
  statusText: string;
  jsonBody?: unknown;
  textBody?: string;
}

function fakeFetch(res: FakeRes, record?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    record?.(String(url), init);
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      json: async () => res.jsonBody ?? {},
      text: async () => res.textBody ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('ApiClient.interrupt — fails loud', () => {
  it('throws (does NOT swallow) on a 409 "nothing was stopped"', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({ ok: false, status: 409, statusText: 'Conflict', textBody: 'nothing was stopped' }),
      basePath: '/api/bridge',
    });
    // A 409 while a tool holds the turn must surface as a thrown error — never a
    // resolved/fake-idle result.
    await expect(api.interrupt('br_1')).rejects.toThrow(/409/);
  });

  it('POSTs to /sessions/{id}/interrupt and resolves on 2xx', async () => {
    const seen: string[] = [];
    const api = new ApiClient({
      fetch: fakeFetch({ ok: true, status: 200, statusText: 'OK', jsonBody: {} }, (u) => seen.push(u)),
      basePath: '/api/bridge',
    });
    await expect(api.interrupt('br_1')).resolves.toBeDefined();
    expect(seen[0]).toBe('/api/bridge/sessions/br_1/interrupt');
  });
});

describe('ApiClient.search', () => {
  it('GETs /sessions/search?q= and returns the hit ids', async () => {
    const seen: string[] = [];
    const api = new ApiClient({
      fetch: fakeFetch({ ok: true, status: 200, statusText: 'OK', jsonBody: { sessionIds: ['br_2', 'br_9'] } }, (u) =>
        seen.push(u),
      ),
      basePath: '/api/bridge',
    });
    const r = await api.search('deploy sync');
    expect(r.sessionIds).toEqual(['br_2', 'br_9']);
    expect(seen[0]).toContain('/sessions/search?q=deploy');
  });

  it('throws on a non-2xx search response', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({ ok: false, status: 500, statusText: 'Server Error' }),
      basePath: '/api/bridge',
    });
    await expect(api.search('x')).rejects.toThrow(/500/);
  });
});

describe('ApiClient.getSessionDetail — snake_case info → camelCase SessionInfo', () => {
  it('GETs /sessions/{id} and maps every info field explicitly', async () => {
    const seen: string[] = [];
    const wire = {
      session_id: 'br_7',
      state: 'idle',
      harness: 'claudecode',
      display_name: 'My session',
      updated_at: '2026-07-27T10:00:00-07:00',
      created_at: '2026-07-27T09:00:00-07:00',
      info: {
        system_prompt: 'You are helpful.',
        append_system_prompt: 'Extra.',
        working_dir: '/home/u/repo',
        model: 'claude-opus',
        permission_mode: 'acceptEdits',
        tools: [{ name: 'Read', description: 'reads' }, { name: 'Bash' }],
        slash_commands: ['/init', '/review'],
        agents: ['Explore'],
        skills: ['browser-automation'],
        mcp_servers: [{ name: 'gmail', status: 'connected' }, { name: 'drive' }],
      },
    };
    const api = new ApiClient({
      fetch: fakeFetch({ ok: true, status: 200, statusText: 'OK', jsonBody: wire }, (u) => seen.push(u)),
      basePath: '/api/bridge',
    });
    const detail = await api.getSessionDetail('br_7');
    expect(seen[0]).toBe('/api/bridge/sessions/br_7');
    // Summary projection reuses summaryFromManaged (single source of truth).
    expect(detail.summary.sessionId).toBe('br_7');
    expect(detail.summary.displayName).toBe('My session');
    // Every info field mapped to camelCase.
    expect(detail.info).toEqual({
      systemPrompt: 'You are helpful.',
      appendSystemPrompt: 'Extra.',
      workingDir: '/home/u/repo',
      model: 'claude-opus',
      permissionMode: 'acceptEdits',
      tools: [{ name: 'Read', description: 'reads' }, { name: 'Bash', description: undefined }],
      slashCommands: ['/init', '/review'],
      agents: ['Explore'],
      skills: ['browser-automation'],
      mcpServers: [{ name: 'gmail', status: 'connected' }, { name: 'drive', status: undefined }],
    });
  });

  it('returns info=null when the harness has reported none', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        jsonBody: { session_id: 'br_8', state: 'starting' },
      }),
      basePath: '/api/bridge',
    });
    const detail = await api.getSessionDetail('br_8');
    expect(detail.summary.sessionId).toBe('br_8');
    expect(detail.info).toBeNull();
  });

  it('throws loudly on a non-2xx detail response', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({ ok: false, status: 404, statusText: 'Not Found' }),
      basePath: '/api/bridge',
    });
    await expect(api.getSessionDetail('nope')).rejects.toThrow(/404/);
  });
});

describe('ApiClient.getSessionDetail — harness_config → camelCase harnessConfig', () => {
  it('maps the well-known keys and carries opaque knobs through', async () => {
    const wire = {
      session_id: 'br_5',
      state: 'idle',
      harness: 'codex',
      updated_at: '2026-07-27T10:00:00-07:00',
      created_at: '2026-07-27T09:00:00-07:00',
      harness_config: {
        permission_mode: 'custom',
        disable_network: true,
        permission_mode_custom: { approval: 'on-request', sandbox: 'workspace-write' },
        model: 'gpt-5',
        effort: 'high',
        // an unnamed harness-specific knob — must survive (opaque bag).
        reasoning_summaries: 'auto',
      },
    };
    const api = new ApiClient({
      fetch: fakeFetch({ ok: true, status: 200, statusText: 'OK', jsonBody: wire }),
      basePath: '/api/bridge',
    });
    const detail = await api.getSessionDetail('br_5');
    expect(detail.sessionId).toBe('br_5');
    expect(detail.harnessConfig).toEqual({
      permissionMode: 'custom',
      disableNetwork: true,
      permissionModeCustom: { approval: 'on-request', sandbox: 'workspace-write' },
      model: 'gpt-5',
      effort: 'high',
      reasoning_summaries: 'auto',
    });
  });

  it('harnessConfig is null when harness_config is absent', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        jsonBody: { session_id: 'br_6', state: 'starting' },
      }),
      basePath: '/api/bridge',
    });
    const detail = await api.getSessionDetail('br_6');
    expect(detail.harnessConfig).toBeNull();
    expect(detail.sessionId).toBe('br_6');
  });
});

describe('ApiClient.setPermissionMode — loud PUT', () => {
  it('PUTs /sessions/{id}/permission-mode with { mode } and resolves on 2xx', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const api = new ApiClient({
      fetch: fakeFetch({ ok: true, status: 200, statusText: 'OK', jsonBody: { status: 'ok' } }, (url, init) =>
        seen.push({ url, init }),
      ),
      basePath: '/api/bridge',
    });
    await expect(api.setPermissionMode('br_1', 'bypass')).resolves.toBeDefined();
    expect(seen[0]!.url).toBe('/api/bridge/sessions/br_1/permission-mode');
    expect(seen[0]!.init?.method).toBe('PUT');
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ mode: 'bypass' });
  });

  it('throws (does NOT swallow) on a non-2xx — e.g. 400 invalid mode', async () => {
    const api = new ApiClient({
      fetch: fakeFetch({ ok: false, status: 400, statusText: 'Bad Request', textBody: 'mode must be one of ...' }),
      basePath: '/api/bridge',
    });
    await expect(api.setPermissionMode('br_1', 'nonsense')).rejects.toThrow(/400/);
  });
});
