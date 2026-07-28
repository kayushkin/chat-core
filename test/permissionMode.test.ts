import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/net/ApiClient.js';
import { createChatStore } from '../src/store/ChatStore.js';
import { changeSessionPermissionMode } from '../src/store/permissionMode.js';
import type { ManagedSessionDetail } from '../src/net/types.js';

function fakeApi(res: { ok: boolean; status: number; statusText?: string }): ApiClient {
  const fetchFn = (async () =>
    ({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText ?? '',
      json: async () => ({ status: 'ok' }),
      text: async () => '',
    }) as unknown as Response) as unknown as typeof fetch;
  return new ApiClient({ fetch: fetchFn, basePath: '/api/bridge' });
}

function detail(mode: string): ManagedSessionDetail {
  return {
    sessionId: 'br_1',
    summary: {
      sessionId: 'br_1',
      state: 'idle',
      harness: 'claudecode',
      instanceId: 'inst1',
      type: 'interactive',
      purpose: 'chat',
      mode: 'events',
      folderName: '',
      displayName: 'br_1',
      agentId: '',
      updatedAt: '2026-07-27T10:00:00-07:00',
      createdAt: '2026-07-27T10:00:00-07:00',
    },
    info: null,
    harnessConfig: { permissionMode: mode },
  };
}

function modeOf(store: ReturnType<typeof createChatStore>): string | undefined {
  return store.getState().sessionDetail.get('br_1')?.harnessConfig?.permissionMode;
}

describe('changeSessionPermissionMode — optimistic + revert', () => {
  it('optimistically patches the cached mode and keeps it on a 2xx PUT', async () => {
    const store = createChatStore();
    store.getState().actions.setSessionDetail('br_1', detail('ask'));
    const api = fakeApi({ ok: true, status: 200 });

    const p = changeSessionPermissionMode({ store, api }, 'br_1', 'bypass');
    // Optimistic: the cached mode flips synchronously, before the PUT resolves.
    expect(modeOf(store)).toBe('bypass');
    await p;
    expect(modeOf(store)).toBe('bypass');
  });

  it('reverts the cached detail and rethrows on a non-2xx PUT', async () => {
    const store = createChatStore();
    store.getState().actions.setSessionDetail('br_1', detail('ask'));
    const api = fakeApi({ ok: false, status: 400, statusText: 'Bad Request' });

    await expect(changeSessionPermissionMode({ store, api }, 'br_1', 'bypass')).rejects.toThrow(/400/);
    // Reverted to the prior mode — a failed change is never silently kept.
    expect(modeOf(store)).toBe('ask');
  });

  it('patchHarnessConfig merges into (not replaces) the existing config', () => {
    const store = createChatStore();
    const d = detail('ask');
    d.harnessConfig = { permissionMode: 'ask', disableNetwork: true, model: 'claude-opus' };
    store.getState().actions.setSessionDetail('br_1', d);

    const prior = store.getState().actions.patchHarnessConfig('br_1', { permissionMode: 'auto' });
    expect(prior).toEqual({ permissionMode: 'ask', disableNetwork: true, model: 'claude-opus' });
    // The patch merges — the other knobs survive.
    expect(store.getState().sessionDetail.get('br_1')?.harnessConfig).toEqual({
      permissionMode: 'auto',
      disableNetwork: true,
      model: 'claude-opus',
    });
  });

  it('patchHarnessConfig is a no-op (returns null) when the detail is not cached', () => {
    const store = createChatStore();
    expect(store.getState().actions.patchHarnessConfig('nope', { permissionMode: 'auto' })).toBeNull();
  });
});
