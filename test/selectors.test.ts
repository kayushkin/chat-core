import { describe, expect, it } from 'vitest';
import { createChatStore, EMPTY_FILTER, type FilterState } from '../src/store/ChatStore.js';
import { matchesFilter, visibleCount, visibleSessions } from '../src/store/selectors.js';
import type { SessionSummary } from '../src/net/types.js';

function summary(over: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    state: 'idle',
    harness: 'claudecode',
    instanceId: 'inst1',
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

function seed(list: SessionSummary[], filter?: Partial<FilterState>) {
  const store = createChatStore();
  store.getState().actions.setSessions(list);
  if (filter) store.getState().actions.setFilter(filter);
  return store;
}

describe('selectors — filter / group / sort', () => {
  it('groups sessions by folder and sorts newest-first within a group', () => {
    const store = seed([
      summary({ sessionId: 'a', folderName: 'work', updatedAt: '2026-07-27T09:00:00-07:00' }),
      summary({ sessionId: 'b', folderName: 'work', updatedAt: '2026-07-27T11:00:00-07:00' }),
      summary({ sessionId: 'c', folderName: 'home', updatedAt: '2026-07-27T12:00:00-07:00' }),
    ]);
    const groups = visibleSessions(store.getState());
    // 'home' group is first (its newest session at 12:00 beats work's 11:00).
    expect(groups.map((g) => g.folder)).toEqual(['home', 'work']);
    const work = groups.find((g) => g.folder === 'work')!;
    expect(work.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']); // newest-first
  });

  it('filters by harness, state, and search', () => {
    const list = [
      summary({ sessionId: 'a', harness: 'claudecode', state: 'idle', displayName: 'Refactor sync' }),
      summary({ sessionId: 'b', harness: 'codex', state: 'idle', displayName: 'Fix bug' }),
      summary({ sessionId: 'c', harness: 'claudecode', state: 'completed', displayName: 'Refactor cache' }),
    ];

    expect(matchesFilter(list[0]!, { ...EMPTY_FILTER, harness: 'claudecode' })).toBe(true);
    expect(matchesFilter(list[1]!, { ...EMPTY_FILTER, harness: 'claudecode' })).toBe(false);

    const byHarness = seed(list, { harness: 'claudecode' });
    expect(visibleCount(byHarness.getState())).toBe(2);

    const byState = seed(list, { status: 'idle' });
    expect(visibleCount(byState.getState())).toBe(2);

    const bySearch = seed(list, { search: 'refactor' });
    const ids = visibleSessions(bySearch.getState())
      .flatMap((g) => g.sessions.map((s) => s.sessionId))
      .sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('filters by folder', () => {
    const store = seed(
      [
        summary({ sessionId: 'a', folderName: 'archive' }),
        summary({ sessionId: 'b', folderName: '' }),
      ],
      { folder: 'archive' },
    );
    const ids = visibleSessions(store.getState()).flatMap((g) => g.sessions.map((s) => s.sessionId));
    expect(ids).toEqual(['a']);
  });

  it('memoizes: identical inputs return the same reference', () => {
    const store = seed([summary({ sessionId: 'a' })]);
    const first = visibleSessions(store.getState());
    const second = visibleSessions(store.getState());
    expect(second).toBe(first);
  });
});
