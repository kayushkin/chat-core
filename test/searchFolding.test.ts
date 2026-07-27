import { describe, expect, it } from 'vitest';
import { createChatStore } from '../src/store/ChatStore.js';
import { visibleSessions, visibleCount } from '../src/store/selectors.js';
import type { SessionSummary } from '../src/net/types.js';

function summary(over: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    state: 'idle',
    harness: 'claudecode',
    instanceId: 'i',
    type: 'interactive',
    purpose: 'chat',
    mode: 'events',
    folderName: '',
    displayName: over.sessionId,
    agentId: '',
    updatedAt: '2026-07-27T10:00:00-07:00',
    createdAt: '2026-07-27T10:00:00-07:00',
    ...over,
  };
}

function ids(store: ReturnType<typeof createChatStore>): string[] {
  return visibleSessions(store.getState())
    .flatMap((g) => g.sessions.map((s) => s.sessionId))
    .sort();
}

describe('content-search folding (C6)', () => {
  it('name match is instant and needs no content hits', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([
      summary({ sessionId: 'a', displayName: 'Alpha deploy' }),
      summary({ sessionId: 'b', displayName: 'Beta' }),
    ]);
    store.getState().actions.setFilter({ search: 'alpha' });
    expect(ids(store)).toEqual(['a']);
  });

  it('folds content-hit ids in when the async search returns', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([
      summary({ sessionId: 'a', displayName: 'Alpha' }),
      summary({ sessionId: 'b', displayName: 'Beta' }),
      summary({ sessionId: 'c', displayName: 'Gamma' }),
    ]);
    // A query that matches NO display name.
    store.getState().actions.setFilter({ search: 'kubernetes' });
    expect(visibleCount(store.getState())).toBe(0);

    // The async content search says b + c mention it in their transcripts.
    store.getState().actions.setContentHits('kubernetes', ['b', 'c']);
    expect(ids(store)).toEqual(['b', 'c']);
  });

  it('ignores a stale content-hit response for a different query', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([summary({ sessionId: 'a', displayName: 'Alpha' })]);
    store.getState().actions.setFilter({ search: 'kubernetes' });
    store.getState().actions.setContentHits('docker', ['a']); // query mismatch → ignored
    expect(visibleCount(store.getState())).toBe(0);
  });

  it('invalidates prior hits when the search query changes', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([summary({ sessionId: 'b', displayName: 'Beta' })]);
    store.getState().actions.setFilter({ search: 'kubernetes' });
    store.getState().actions.setContentHits('kubernetes', ['b']);
    expect(ids(store)).toEqual(['b']);
    // Change the query — the stale 'kubernetes' hits must not leak into 'docker'.
    store.getState().actions.setFilter({ search: 'docker' });
    expect(visibleCount(store.getState())).toBe(0);
  });
});
