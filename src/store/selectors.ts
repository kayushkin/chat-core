import type { Entry, SessionSummary, Turn, TurnModel } from '../net/types.js';
import { annotateOTelDuplicates, groupMembers } from '../reduce/otelDedup.js';
import type { ChatState, FilterState } from './ChatStore.js';

// Memoized selectors over the hot store. Kept pure + framework-free so they are
// testable in isolation and cheap enough to run on every render (the memo cache
// short-circuits when inputs are identity-equal). The React hooks bind to these.

export interface FolderGroup {
  folder: string;
  sessions: SessionSummary[];
}

/** True iff a session passes the current filter. Empty/null filter fields match
 *  everything; `search` matches the display name case-insensitively. */
export function matchesFilter(s: SessionSummary, f: FilterState): boolean {
  if (f.harness && s.harness !== f.harness) return false;
  if (f.status && s.state !== f.status) return false;
  if (f.type && s.type !== f.type) return false;
  if (f.purpose && s.purpose !== f.purpose) return false;
  if (f.mode && s.mode !== f.mode) return false;
  if (f.folder && s.folderName !== f.folder) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const name = (s.displayName || s.sessionId).toLowerCase();
    if (!name.includes(q)) return false;
  }
  return true;
}

function byUpdatedDesc(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt < b.updatedAt) return 1;
  if (a.updatedAt > b.updatedAt) return -1;
  return 0;
}

// Simple identity-keyed memo: recompute only when (sessions, filter) change.
let visibleCache: {
  sessions: Map<string, SessionSummary>;
  filter: FilterState;
  result: FolderGroup[];
} | null = null;

/** Filter → group-by-folder → sort. Groups are ordered by their most-recent
 *  session; sessions within a group are newest-first. Memoized on identity of
 *  the sessions Map + filter object. */
export function visibleSessions(state: ChatState): FolderGroup[] {
  const { sessions, filter } = state;
  if (visibleCache && visibleCache.sessions === sessions && visibleCache.filter === filter) {
    return visibleCache.result;
  }
  const byFolder = new Map<string, SessionSummary[]>();
  for (const s of sessions.values()) {
    if (!matchesFilter(s, filter)) continue;
    const folder = s.folderName || '';
    let arr = byFolder.get(folder);
    if (!arr) {
      arr = [];
      byFolder.set(folder, arr);
    }
    arr.push(s);
  }
  const groups: FolderGroup[] = [];
  for (const [folder, arr] of byFolder) {
    arr.sort(byUpdatedDesc);
    groups.push({ folder, sessions: arr });
  }
  // Groups ordered by their newest session (a group's freshest activity).
  groups.sort((a, b) => {
    const an = a.sessions[0]?.updatedAt ?? '';
    const bn = b.sessions[0]?.updatedAt ?? '';
    return an < bn ? 1 : an > bn ? -1 : 0;
  });
  visibleCache = { sessions, filter, result: groups };
  return groups;
}

/** Total visible session count across all groups. */
export function visibleCount(state: ChatState): number {
  return visibleSessions(state).reduce((n, g) => n + g.sessions.length, 0);
}

/** The active session's summary, or null. */
export function activeSummary(state: ChatState): SessionSummary | null {
  if (!state.activeId) return null;
  return state.sessions.get(state.activeId) ?? null;
}

/** The materialized model for a session, or undefined if not warm. */
export function turnsFor(state: ChatState, sessionId: string | null): TurnModel | undefined {
  if (!sessionId) return undefined;
  return state.turnsBySession.get(sessionId);
}

/** Turns for a session, or an empty array. */
export function turnList(state: ChatState, sessionId: string | null): Turn[] {
  return turnsFor(state, sessionId)?.turns ?? [];
}

/** Entry map for a session, or an empty record. */
export function entriesFor(state: ChatState, sessionId: string | null): Record<string, Entry> {
  return turnsFor(state, sessionId)?.entries ?? {};
}

/**
 * The entry ids to render for a turn, respecting the view:
 *  - 'turns' (collapsed): only `!duplicate` entries — the dedup selector.
 *  - 'raw'   (timeline):  every entry, ordered by eventId — the audit surface.
 * A pure selector over the full, annotated model; never a stored lossy form.
 */
export function visibleEntryIdsFor(
  model: TurnModel | undefined,
  turnId: string,
  view: 'turns' | 'raw',
): string[] {
  if (!model) return [];
  const turn = model.turns.find((t) => t.id === turnId);
  if (!turn) return [];
  const ids = turn.entryIds
    .slice()
    .sort((a, b) => (model.entries[a]?.eventId ?? 0) - (model.entries[b]?.eventId ?? 0));
  if (view === 'raw') return ids;
  return ids.filter((id) => !model.entries[id]?.duplicate);
}

/** All copies in an entry's dedup group (the sources badge). Recomputes the
 *  annotation over the model's entries to answer independent of storage. */
export function sourcesForEntry(model: TurnModel | undefined, entryId: string): Entry[] {
  if (!model) return [];
  const annotated = annotateOTelDuplicates(Object.values(model.entries));
  return groupMembers(annotated, entryId);
}
