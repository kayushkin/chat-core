import { describe, expect, it } from 'vitest';
import { createChatStore } from '../src/store/ChatStore.js';
import { selectContentSearchReach, visibleSessions, visibleCount } from '../src/store/selectors.js';
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

  // The comparison between `filter.search` (raw, as typed) and `contentHits.query`
  // (trimmed by the caller) used to be made without trimming, so every hit for a
  // query with a stray space was discarded on arrival and search silently matched
  // nothing. A trailing space is one keystroke away in normal typing.
  it('keeps hits for a query the user typed with surrounding whitespace', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([
      summary({ sessionId: 'a', displayName: 'Alpha' }),
      summary({ sessionId: 'b', displayName: 'Beta' }),
    ]);
    store.getState().actions.setFilter({ search: '  kubernetes  ' });
    store.getState().actions.setContentHits('kubernetes', ['b']);
    expect(ids(store)).toEqual(['b']);
  });

  it('matches a display name for a query typed with surrounding whitespace', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([summary({ sessionId: 'a', displayName: 'Alpha' })]);
    store.getState().actions.setFilter({ search: ' alpha ' });
    expect(ids(store)).toEqual(['a']);
  });
});

describe('content-search reach — the shortfall must be reportable', () => {
  it('is null when no content search is active', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([summary({ sessionId: 'a' })]);
    expect(selectContentSearchReach(store.getState())).toBeNull();
  });

  it('is null while the hits for the live query have not landed', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([summary({ sessionId: 'a' })]);
    store.getState().actions.setFilter({ search: 'kubernetes' });
    expect(selectContentSearchReach(store.getState())).toBeNull();
  });

  it('counts hits the loaded window cannot paint as hidden', () => {
    const store = createChatStore();
    // Only `b` is loaded; the backend matched three sessions.
    store.getState().actions.setSessions([summary({ sessionId: 'b', displayName: 'Beta' })]);
    store.getState().actions.setFilter({ search: 'kubernetes' });
    store.getState().actions.setContentHits('kubernetes', ['b', 'offscreen1', 'offscreen2']);
    const reach = selectContentSearchReach(store.getState());
    expect(reach).not.toBeNull();
    expect(reach!.hitCount).toBe(3);
    expect(reach!.shownHitCount).toBe(1);
    expect(reach!.hiddenHitCount).toBe(2);
    expect(reach!.truncated).toBe(false);
  });

  it('reports nothing hidden when every hit is loaded', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([
      summary({ sessionId: 'a', displayName: 'Alpha' }),
      summary({ sessionId: 'b', displayName: 'Beta' }),
    ]);
    store.getState().actions.setFilter({ search: 'kubernetes' });
    store.getState().actions.setContentHits('kubernetes', ['a', 'b']);
    const reach = selectContentSearchReach(store.getState());
    expect(reach!.hitCount).toBe(2);
    expect(reach!.shownHitCount).toBe(2);
    expect(reach!.hiddenHitCount).toBe(0);
  });

  // A hit that IS loaded but is filtered out by another axis is honestly hidden:
  // counting against `state.sessions` instead of the rendered rows would claim it
  // was on screen when the user cannot see it.
  it('counts a loaded hit removed by another filter axis as hidden', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([
      summary({ sessionId: 'a', displayName: 'Alpha', harness: 'claudecode' }),
      summary({ sessionId: 'b', displayName: 'Beta', harness: 'codex' }),
    ]);
    store.getState().actions.setFilter({ search: 'kubernetes', harness: ['claudecode'] });
    store.getState().actions.setContentHits('kubernetes', ['a', 'b']);
    const reach = selectContentSearchReach(store.getState());
    expect(reach!.hitCount).toBe(2);
    expect(reach!.shownHitCount).toBe(1);
    expect(reach!.hiddenHitCount).toBe(1);
  });

  it('carries the backend truncation flag through', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([summary({ sessionId: 'a', displayName: 'Alpha' })]);
    store.getState().actions.setFilter({ search: 'kubernetes' });
    store.getState().actions.setContentHits('kubernetes', ['a'], true);
    expect(selectContentSearchReach(store.getState())!.truncated).toBe(true);
  });
});
