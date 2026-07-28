import { describe, expect, it } from 'vitest';
import { createChatStore, EMPTY_FILTER } from '../src/store/ChatStore.js';
import { matchesFilter, selectFacets, visibleSessions } from '../src/store/selectors.js';
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

const list = [
  summary({ sessionId: 'a', harness: 'claudecode', state: 'idle', instanceId: 'inst1', purpose: 'chat' }),
  summary({ sessionId: 'b', harness: 'codex', state: 'running', instanceId: 'inst2', purpose: 'autoworker' }),
  summary({ sessionId: 'c', harness: 'gemini', state: 'idle', instanceId: 'inst1', purpose: 'chat' }),
  summary({ sessionId: 'd', harness: 'codex', state: 'completed', instanceId: 'inst3', purpose: 'chat' }),
];

function seed(filter?: Partial<typeof EMPTY_FILTER>) {
  const store = createChatStore();
  store.getState().actions.setSessions(list);
  if (filter) store.getState().actions.setFilter(filter);
  return store;
}

function ids(store: ReturnType<typeof createChatStore>): string[] {
  return visibleSessions(store.getState())
    .flatMap((g) => g.sessions.map((s) => s.sessionId))
    .sort();
}

describe('matchesFilter — multi-select axes', () => {
  it('empty array on an axis matches everything', () => {
    for (const s of list) {
      expect(matchesFilter(s, { ...EMPTY_FILTER, harness: [] })).toBe(true);
    }
  });

  it('OR within an axis (any selected value matches)', () => {
    const f = { ...EMPTY_FILTER, harness: ['claudecode', 'gemini'] };
    expect(matchesFilter(list[0]!, f)).toBe(true); // claudecode
    expect(matchesFilter(list[2]!, f)).toBe(true); // gemini
    expect(matchesFilter(list[1]!, f)).toBe(false); // codex — not selected
  });

  it('AND across axes (every non-empty axis must match)', () => {
    // harness ∈ {codex} AND status ∈ {running}
    const f = { ...EMPTY_FILTER, harness: ['codex'], status: ['running'] };
    expect(matchesFilter(list[1]!, f)).toBe(true); // b: codex + running
    expect(matchesFilter(list[3]!, f)).toBe(false); // d: codex but completed
  });

  it('machine axis matches instanceId (the summary has no machine field)', () => {
    const f = { ...EMPTY_FILTER, machine: ['inst1'] };
    expect(matchesFilter(list[0]!, f)).toBe(true); // inst1
    expect(matchesFilter(list[2]!, f)).toBe(true); // inst1
    expect(matchesFilter(list[1]!, f)).toBe(false); // inst2
  });

  it('drives visibleSessions end-to-end (OR within, AND across)', () => {
    // harness ∈ {claudecode, gemini} AND status ∈ {idle} → a and c.
    const store = seed({ harness: ['claudecode', 'gemini'], status: ['idle'] });
    expect(ids(store)).toEqual(['a', 'c']);

    // machine ∈ {inst1, inst3} → a, c, d.
    const byMachine = seed({ machine: ['inst1', 'inst3'] });
    expect(ids(byMachine)).toEqual(['a', 'c', 'd']);

    // no filter → all four.
    const all = seed();
    expect(ids(all)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('selectFacets — counts over the FULL loaded set', () => {
  it('tallies every axis independent of the active filter', () => {
    // Even with a filter that hides most rows, facets count the full set.
    const store = seed({ harness: ['codex'] });
    const facets = selectFacets(store.getState());
    expect(facets.harness).toEqual({ claudecode: 1, codex: 2, gemini: 1 });
    expect(facets.status).toEqual({ idle: 2, running: 1, completed: 1 });
    expect(facets.type).toEqual({ interactive: 4 });
    expect(facets.purpose).toEqual({ chat: 3, autoworker: 1 });
    expect(facets.mode).toEqual({ events: 4 });
    expect(facets.machine).toEqual({ inst1: 2, inst2: 1, inst3: 1 });
  });

  it('skips empty-string axis values (unfiled/unknown is not a facet)', () => {
    const store = createChatStore();
    store.getState().actions.setSessions([
      summary({ sessionId: 'x', harness: '', instanceId: '' }),
      summary({ sessionId: 'y', harness: 'codex', instanceId: 'inst9' }),
    ]);
    const facets = selectFacets(store.getState());
    expect(facets.harness).toEqual({ codex: 1 });
    expect(facets.machine).toEqual({ inst9: 1 });
  });

  it('memoizes on the sessions Map identity', () => {
    const store = seed();
    const first = selectFacets(store.getState());
    const second = selectFacets(store.getState());
    expect(second).toBe(first);
  });
});
