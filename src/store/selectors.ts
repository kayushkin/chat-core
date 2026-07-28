import type { Entry, SessionSummary, Turn, TurnModel } from '../net/types.js';
import { annotateOTelDuplicates, groupMembers } from '../reduce/otelDedup.js';
import { terminalStateFromTail } from '../reduce/terminalState.js';
import type { ChatState, ContentHits, FilterState } from './ChatStore.js';

// Memoized selectors over the hot store. Kept pure + framework-free so they are
// testable in isolation and cheap enough to run on every render (the memo cache
// short-circuits when inputs are identity-equal). The React hooks bind to these.

export interface FolderGroup {
  folder: string;
  sessions: SessionSummary[];
}

/** True iff a session passes the current filter. Empty/null filter fields match
 *  everything; `search` matches the display name case-insensitively AND, when
 *  `contentHits` is supplied (C6 content search), any session whose transcript text
 *  matched the same query. Name matching stays instant/local; the content-hit set
 *  is an async augmentation folded in when it arrives (see `useFilters`). */
export function matchesFilter(
  s: SessionSummary,
  f: FilterState,
  contentHits?: ContentHits | null,
): boolean {
  if (f.harness && s.harness !== f.harness) return false;
  if (f.status && s.state !== f.status) return false;
  if (f.type && s.type !== f.type) return false;
  if (f.purpose && s.purpose !== f.purpose) return false;
  if (f.mode && s.mode !== f.mode) return false;
  if (f.folder && s.folderName !== f.folder) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const name = (s.displayName || s.sessionId).toLowerCase();
    const nameHit = name.includes(q);
    const contentHit =
      !!contentHits && contentHits.query === f.search && contentHits.ids.has(s.sessionId);
    if (!nameHit && !contentHit) return false;
  }
  return true;
}

function byUpdatedDesc(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt < b.updatedAt) return 1;
  if (a.updatedAt > b.updatedAt) return -1;
  return 0;
}

// Simple identity-keyed memo: recompute only when (sessions, filter, contentHits)
// change. contentHits is part of the key so a content-search response repaints.
let visibleCache: {
  sessions: Map<string, SessionSummary>;
  filter: FilterState;
  contentHits: ContentHits | null;
  result: FolderGroup[];
} | null = null;

/** Filter → group-by-folder → sort. Groups are ordered by their most-recent
 *  session; sessions within a group are newest-first. Memoized on identity of
 *  the sessions Map + filter object + content-hit set. */
export function visibleSessions(state: ChatState): FolderGroup[] {
  const { sessions, filter, contentHits } = state;
  if (
    visibleCache &&
    visibleCache.sessions === sessions &&
    visibleCache.filter === filter &&
    visibleCache.contentHits === contentHits
  ) {
    return visibleCache.result;
  }
  const byFolder = new Map<string, SessionSummary[]>();
  for (const s of sessions.values()) {
    if (!matchesFilter(s, filter, contentHits)) continue;
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
  visibleCache = { sessions, filter, contentHits, result: groups };
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

// Summary states that mean "still working" — the ones a terminal tail may override.
// Parked/settled states (awaiting_user, awaiting_permission, paused, idle, completed,
// error, aborted, disconnected) are left untouched: they are not stale spinners.
const RUNNING_STATES = new Set([
  'starting',
  'model_generating',
  'tool_running',
  'compacting',
  'rate_limited',
  'running',
  'holding',
  'waiting_on_approval',
]);

/**
 * The effective (reconciled) state of a session. If the session's cached/warm
 * TurnModel tail is terminal per `terminalStateFromTail`, a running/holding summary
 * state is overridden with the tail's verdict ('completed' | 'failed') — this clears
 * the stale spinner the server's state derivation can strand (F1). A session that is
 * genuinely in flight (no terminal tail) or already in a settled/parked state is
 * returned unchanged.
 */
export function effectiveState(state: ChatState, sessionId: string | null): string {
  if (!sessionId) return '';
  const summary = state.sessions.get(sessionId);
  const raw = summary?.state ?? '';
  if (!RUNNING_STATES.has(raw)) return raw;
  const terminal = terminalStateFromTail(state.turnsBySession.get(sessionId));
  if (!terminal) return raw;
  return terminal === 'failed' ? 'failed' : 'completed';
}

// Memo for the reconciled active summary: recompute only when the summary object or
// its warm TurnModel changes identity, so useStore sees a stable reference between
// unrelated renders (a fresh object every call would loop the subscription).
let activeEffectiveCache: {
  summary: SessionSummary | null;
  model: TurnModel | undefined;
  result: SessionSummary | null;
} | null = null;

/** The active session's summary with its `state` reconciled against the warm tail
 *  (see `effectiveState`). Same reference as `activeSummary` when the tail implies no
 *  correction, so nothing downstream churns. */
export function activeSummaryEffective(state: ChatState): SessionSummary | null {
  const summary = activeSummary(state);
  if (!summary) return null;
  const model = state.turnsBySession.get(summary.sessionId);
  if (activeEffectiveCache && activeEffectiveCache.summary === summary && activeEffectiveCache.model === model) {
    return activeEffectiveCache.result;
  }
  const eff = effectiveState(state, summary.sessionId);
  const result = eff === summary.state ? summary : { ...summary, state: eff };
  activeEffectiveCache = { summary, model, result };
  return result;
}

/** The materialized model for a session, or undefined if not warm. */
export function turnsFor(state: ChatState, sessionId: string | null): TurnModel | undefined {
  if (!sessionId) return undefined;
  return state.turnsBySession.get(sessionId);
}

// ---- Cost / context selectors (from TurnModel.aggregates; pure, no network) ----
//
// Both read the loaded model's roll-up. `aggregates` MAY be absent (the spend/context
// events fell outside the loaded page) — absence reads as zeros, never a fabricated
// figure. Memoized single-slot on the TurnModel's identity (the model is replaced
// immutably on every mutation) so `useStore` sees a stable reference between unrelated
// renders — a fresh object every call would loop the subscription.

/** A session's rolled-up cost, or all-zeros when no aggregates are loaded. */
export interface SessionCost {
  totalUsd: number;
  byModel: Record<string, number>;
  byQuerySource: Record<string, number>;
}

/** A session's context-window usage, or all-zeros when no aggregates are loaded.
 *  `pct` is 0 when the limit is missing (never divide-by-zero). */
export interface ContextUsage {
  tokens: number;
  limit: number;
  pct: number;
}

const EMPTY_COST: SessionCost = { totalUsd: 0, byModel: {}, byQuerySource: {} };
const EMPTY_CONTEXT: ContextUsage = { tokens: 0, limit: 0, pct: 0 };

let costCache: { model: TurnModel | undefined; result: SessionCost } | null = null;

/** Cost roll-up for a session from `TurnModel.aggregates`; zeros when absent. */
export function sessionCost(state: ChatState, sessionId: string | null): SessionCost {
  const model = turnsFor(state, sessionId);
  if (costCache && costCache.model === model) return costCache.result;
  const agg = model?.aggregates;
  const result: SessionCost = agg
    ? {
        totalUsd: agg.totalUsd ?? 0,
        byModel: agg.byModel ?? {},
        byQuerySource: agg.byQuerySource ?? {},
      }
    : EMPTY_COST;
  costCache = { model, result };
  return result;
}

let contextCache: { model: TurnModel | undefined; result: ContextUsage } | null = null;

/** Context-window usage for a session from `TurnModel.aggregates`; zeros when absent.
 *  `pct = tokens/limit*100`, or 0 when the limit is missing/zero. */
export function contextUsage(state: ChatState, sessionId: string | null): ContextUsage {
  const model = turnsFor(state, sessionId);
  if (contextCache && contextCache.model === model) return contextCache.result;
  const agg = model?.aggregates;
  const tokens = agg?.contextTokens ?? 0;
  const limit = agg?.contextLimit ?? 0;
  const result: ContextUsage =
    tokens === 0 && limit === 0
      ? EMPTY_CONTEXT
      : { tokens, limit, pct: limit > 0 ? (tokens / limit) * 100 : 0 };
  contextCache = { model, result };
  return result;
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

// ---- Timeline selector (Path A Timeline pane) ----
//
// A pure, memoizable transform of the materialized `entries` into the
// event-granular, turn→task-grouped structure the Timeline pane renders. It mirrors
// the grouping semantics of bridge-ui `Timeline.tsx` rowsToTimeline (group by turn,
// sub-group tool/thinking/result/error, respect task_* scoping) but returns DATA,
// not JSX — the pane stays presentation-only and never re-derives. Being the raw
// audit surface (see WIRE.md), it is event-granular: every entry is represented,
// ordered by eventId, so the timeline can reconstruct every stored event.

export type TimelineTone =
  | 'turn'
  | 'task-start'
  | 'thinking'
  | 'tool'
  | 'tool-done'
  | 'tool-err'
  | 'result'
  | 'error'
  | 'system'
  | 'text';

/** One event-granular row in the timeline (presentation-agnostic). */
export interface TimelineItem {
  key: string;
  entryId: string;
  turnId: string;
  /** Set on rows scoped to an active task_* span (bridge-ui task grouping). */
  taskId?: string;
  icon: string;
  label: string;
  detail?: string; // one-line preview
  fullText?: string; // untruncated source text
  ts: string;
  tone: TimelineTone;
}

/** A child of a turn: either a standalone item or a task-scoped sub-group. */
export type TimelineNode =
  | { type: 'item'; item: TimelineItem }
  | { type: 'task'; taskId: string; header: TimelineItem; children: TimelineItem[] };

/** A turn group: its header row (the user prompt / first event) + grouped children. */
export interface TimelineTurnGroup {
  turnId: string;
  header: TimelineItem;
  children: TimelineNode[];
}

/** The full render-ready structure: the flat ordered items plus the turn→task tree. */
export interface TimelineView {
  items: TimelineItem[];
  turns: TimelineTurnGroup[];
  count: number;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

function toolIsError(e: Entry): boolean {
  const tr = (e.raw as { tool_result?: { is_error?: boolean } } | undefined)?.tool_result;
  return tr?.is_error === true;
}

function toolText(e: Entry): string | undefined {
  const parts: string[] = [];
  if (e.toolInput !== undefined) {
    parts.push(typeof e.toolInput === 'string' ? e.toolInput : safeJson(e.toolInput));
  }
  if (e.toolResult !== undefined) {
    parts.push(typeof e.toolResult === 'string' ? e.toolResult : safeJson(e.toolResult));
  }
  const s = parts.filter(Boolean).join(' → ');
  return s.length > 0 ? s : undefined;
}

function makeItem(
  e: Entry,
  o: { icon: string; label: string; tone: TimelineTone; taskId?: string; text?: string },
): TimelineItem {
  const item: TimelineItem = {
    key: `tl_${e.id}`,
    entryId: e.id,
    turnId: e.turnId,
    icon: o.icon,
    label: o.label,
    ts: e.ts,
    tone: o.tone,
  };
  if (o.taskId) item.taskId = o.taskId;
  const line = o.text ? oneLine(o.text) : '';
  if (line) {
    item.detail = line;
    item.fullText = o.text;
  }
  return item;
}

/** Flatten the model's entries into ordered timeline items, tracking task_* scope
 *  exactly as bridge-ui rowsToTimeline does (start opens a scope, user_message and
 *  result close it, repeated task events fold their description into the header). */
function toTimelineItems(model: TurnModel): TimelineItem[] {
  const entries = Object.values(model.entries)
    .slice()
    .sort((a, b) => a.eventId - b.eventId);

  const out: TimelineItem[] = [];
  const seenTurn = new Set<string>();
  const taskIdxByScope = new Map<string, number>();
  let currentTurnId: string | undefined;
  let currentTaskId: string | undefined;

  for (const e of entries) {
    if (e.turnId !== currentTurnId) {
      currentTurnId = e.turnId;
      currentTaskId = undefined;
      taskIdxByScope.clear();
    }

    // User prompt → the turn header row.
    if (e.role === 'user') {
      currentTaskId = undefined;
      const first = !seenTurn.has(e.turnId);
      seenTurn.add(e.turnId);
      out.push(makeItem(e, { icon: first ? '▶' : '»', label: 'Turn', tone: 'turn', text: e.text }));
      continue;
    }

    // task_* scope marker (system entry whose subtype starts with task_).
    if (e.kind === 'system' && e.subtype && e.subtype.startsWith('task_')) {
      const raw = (e.raw ?? {}) as Record<string, unknown>;
      const rawSys = (raw.system ?? {}) as Record<string, unknown>;
      const explicitId = asString(raw.task_id) ?? asString(rawSys.task_id);
      const isStart = e.subtype === 'task_started';
      if (isStart) currentTaskId = explicitId ?? `task_${e.id}`;
      else if (explicitId && !currentTaskId) currentTaskId = explicitId;
      const description =
        asString(raw.description) ??
        asString(rawSys.description) ??
        asString(rawSys.message) ??
        asString(e.text) ??
        '';

      if (currentTaskId && taskIdxByScope.has(currentTaskId)) {
        const idx = taskIdxByScope.get(currentTaskId)!;
        const existing = out[idx];
        if (existing && !existing.detail && description) {
          existing.detail = oneLine(description);
          existing.fullText = description;
        }
        continue;
      }
      out.push(
        makeItem(e, {
          icon: '▣',
          label: 'Task',
          tone: 'task-start',
          taskId: currentTaskId,
          text: description || undefined,
        }),
      );
      if (currentTaskId) taskIdxByScope.set(currentTaskId, out.length - 1);
      continue;
    }

    if (e.kind === 'thinking') {
      out.push(
        makeItem(e, {
          icon: '💭',
          label: 'Thinking',
          tone: 'thinking',
          taskId: currentTaskId,
          text: e.text,
        }),
      );
      continue;
    }

    if (e.kind === 'tool_call' || e.kind === 'tool_result') {
      const done = e.kind === 'tool_result' || e.toolResult !== undefined;
      const err = toolIsError(e);
      out.push(
        makeItem(e, {
          icon: err ? '✗' : done ? '✓' : '⚙',
          label: e.toolName || 'tool',
          tone: err ? 'tool-err' : done ? 'tool-done' : 'tool',
          taskId: currentTaskId,
          text: toolText(e),
        }),
      );
      continue;
    }

    if (e.kind === 'result') {
      currentTaskId = undefined;
      out.push(makeItem(e, { icon: '■', label: 'Done', tone: 'result', text: e.text }));
      continue;
    }

    if (e.kind === 'error') {
      out.push(
        makeItem(e, {
          icon: '⚠',
          label: 'Error',
          tone: 'error',
          taskId: currentTaskId,
          text: e.text,
        }),
      );
      continue;
    }

    if (e.kind === 'system') {
      out.push(
        makeItem(e, {
          icon: 'ⓘ',
          label: e.subtype || 'System',
          tone: 'system',
          taskId: currentTaskId,
          text: e.text,
        }),
      );
      continue;
    }

    if (e.kind === 'text' && e.text) {
      out.push(
        makeItem(e, { icon: '✎', label: 'Text', tone: 'text', taskId: currentTaskId, text: e.text }),
      );
      continue;
    }
    // meta / empty entries carry nothing to render — skipped, as bridge-ui does.
  }
  return out;
}

function groupTaskChildren(items: TimelineItem[]): TimelineNode[] {
  const out: TimelineNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if (!it.taskId) {
      out.push({ type: 'item', item: it });
      i++;
      continue;
    }
    const taskId = it.taskId;
    const start = i;
    while (i < items.length && items[i]!.taskId === taskId) i++;
    const slice = items.slice(start, i);
    out.push({ type: 'task', taskId, header: slice[0]!, children: slice.slice(1) });
  }
  return out;
}

function groupTurns(items: TimelineItem[]): TimelineTurnGroup[] {
  const groups: TimelineTurnGroup[] = [];
  let i = 0;
  while (i < items.length) {
    const turnId = items[i]!.turnId;
    const start = i;
    while (i < items.length && items[i]!.turnId === turnId) i++;
    const slice = items.slice(start, i);
    groups.push({ turnId, header: slice[0]!, children: groupTaskChildren(slice.slice(1)) });
  }
  return groups;
}

// Identity memo: the TurnModel is replaced immutably on every mutation, so
// referential equality is a correct and cheap staleness check.
let timelineCache: { model: TurnModel | undefined; result: TimelineView } | null = null;

/**
 * Build the event-granular, turn→task-grouped timeline for a materialized model.
 * Pure + memoized on the model's identity so the Timeline pane never re-derives.
 */
export function selectTimeline(model: TurnModel | undefined): TimelineView {
  if (timelineCache && timelineCache.model === model) return timelineCache.result;
  const items = model ? toTimelineItems(model) : [];
  const result: TimelineView = { items, turns: groupTurns(items), count: items.length };
  timelineCache = { model, result };
  return result;
}
