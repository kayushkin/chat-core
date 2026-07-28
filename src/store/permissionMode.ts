import type { ApiClient } from '../net/ApiClient.js';
import type { ChatStoreApi } from './ChatStore.js';

/**
 * Optimistically set a session's permission mode and reconcile with the server.
 *
 * Patches the cached `ManagedSessionDetail`'s `harnessConfig.permissionMode`
 * immediately (so the selector reflects the choice at once), PUTs
 * `/sessions/{id}/permission-mode`, and — on a non-2xx — REVERTS the cached detail to
 * its prior value and rethrows. A failed change must surface, never be silently kept.
 *
 * Shared by `useManagedSession` so the orchestration is exercised directly by tests
 * rather than re-derived in a React-lifecycle harness (single source of truth).
 */
export async function changeSessionPermissionMode(
  deps: { store: ChatStoreApi; api: ApiClient },
  sessionId: string,
  mode: string,
): Promise<void> {
  const { store, api } = deps;
  // Snapshot the prior detail so a failed PUT can revert cleanly.
  const prior = store.getState().sessionDetail.get(sessionId) ?? null;
  store.getState().actions.patchHarnessConfig(sessionId, { permissionMode: mode });
  try {
    await api.setPermissionMode(sessionId, mode);
  } catch (e) {
    if (prior) store.getState().actions.setSessionDetail(sessionId, prior);
    throw e;
  }
}
