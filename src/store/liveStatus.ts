import type { Entry, SessionSummary, TurnModel } from '../net/types.js';
import { isTerminalTaskStatus } from './selectors.js';
import { resultedToolIds, toolIdOf } from './toolPairing.js';

// LIVE STATUS: what a running turn is doing at this instant, at one level more
// detail than `ActivityKind`. The activity fold answers with one word (thinking /
// streaming / tool name); this derivation reads the materialized model for the
// facts behind the word — the in-progress todo the harness declared, the exact
// tool calls still awaiting a result, and every subagent still working — so a
// status line can say `Bash — cat thing.txt` and `Explore — "find the parser"`
// instead of `tool`.
//
// Everything here is read from the CURRENT (last) turn only, except the todo
// label, which persists across turns the way the harness's own todo list does.
// Scoping to the last turn is what keeps an aborted turn's forever-unpaired tool
// calls from rendering as running for the rest of the session.

/** A tool call the model has issued and not yet received a result for. */
export interface LiveToolCall {
  /** The tool's name; empty when the event carried none. */
  name: string;
  /** One-line human summary of the call's input — see `toolCallSummary`. */
  summary: string;
  /** Server timestamp of the tool_call event (RFC3339 + offset). */
  startedAt: string;
}

/** A harness task (subagent or backgrounded shell) that has started and not yet
 *  reported a terminal status. */
export interface LiveSubagent {
  taskId: string;
  /** What the task was asked to do — the parent's `task_started` narration. */
  description: string;
  /** The agent role it was spawned as (`Explore`, …); absent for a shell task
   *  and for a harness that does not report one. */
  subagentType?: string;
  /** `local_agent`, `local_bash`, … — only an agent kind gets a promoted session. */
  taskType?: string;
  /** The tool the subagent last reported running (`task_progress`). */
  lastToolName?: string;
  /** Server timestamp of the task_started event (RFC3339 + offset). */
  startedAt: string;
  /** The subagent's own bridge session, when the server promoted one. Joined by
   *  `joinSubagentSessions` on `harnessSessionId === "agent-" + taskId` — an id the
   *  server derives from the task id precisely so the two records converge. */
  sessionId?: string;
}

/** The model-derived half of a live status line (no session join, no activity). */
export interface LiveTurnStatus {
  /** The harness's own in-progress todo item, when its latest todo list has one.
   *  `text` prefers the item's active form ("Refactoring the parser") over its
   *  imperative form ("Refactor the parser"). */
  todo?: { text: string; sinceTs: string };
  /** Tool calls in flight this turn, oldest first. A call whose task_started
   *  narration already claimed it (a running subagent's own Task call) is listed
   *  as a subagent instead, never twice. */
  toolCalls: LiveToolCall[];
  /** Tasks started this turn with no terminal status yet, oldest first. */
  subagents: LiveSubagent[];
  /** Timestamp of the newest entry in the last turn — the "latest call started"
   *  stamp when nothing more specific (a tool call) is in flight. */
  lastEntryTs?: string;
}

const MAX_SUMMARY_CHARS = 120;

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS - 1)}…` : flat;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The input field that best names what a call is doing, per tool. This is
 *  presentation knowledge (which is why the timeline's generic `toolText` never
 *  grew it), but it lives here rather than at each edge so dash and bridge-ui
 *  summarize a call with the same words. Unlisted tools fall through to the
 *  first string field of their input. */
const SUMMARY_FIELD_BY_TOOL: Record<string, string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  Task: ['description', 'prompt'],
  Agent: ['description', 'prompt'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Skill: ['skill'],
};

/**
 * One human line for a tool call's input: `cat thing.txt` for Bash, the file
 * path for Read/Write/Edit, the description for Task — never the raw JSON blob
 * unless the input has no string field at all. Whitespace-collapsed and capped
 * at 120 chars; the full input stays on the entry for the expanded views.
 */
export function toolCallSummary(name: string | undefined, input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return truncate(input);
  if (typeof input !== 'object') return truncate(String(input));
  const record = input as Record<string, unknown>;
  for (const field of SUMMARY_FIELD_BY_TOOL[name ?? ''] ?? []) {
    const value = asString(record[field]);
    if (value) return truncate(value);
  }
  for (const value of Object.values(record)) {
    const s = asString(value);
    if (s) return truncate(s);
  }
  try {
    return truncate(JSON.stringify(record));
  } catch {
    return '';
  }
}

/** The shape of one item in a harness todo list (Claude Code's TodoWrite input).
 *  Read defensively — the input is an untyped blob from the wire. */
function inProgressTodoText(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return undefined;
  for (const item of todos) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.status !== 'in_progress') continue;
    return asString(record.activeForm) ?? asString(record.content);
  }
  return undefined;
}

const EMPTY_STATUS: LiveTurnStatus = { toolCalls: [], subagents: [] };

// Identity memo, one slot per model — same pattern and same rationale as
// `selectTimeline`: the TurnModel is replaced immutably on every mutation, so
// referential equality is a correct staleness check, and a WeakMap keeps the
// entry alive exactly as long as the model it describes.
const statusByModel = new WeakMap<TurnModel, LiveTurnStatus>();

/**
 * Derive the live-status facts from a materialized model. Pure + memoized on the
 * model's identity. Says nothing about whether the session is BUSY — that is the
 * activity fold's job; a status line renders this only while the turn is live.
 */
export function liveStatusFromModel(model: TurnModel | undefined): LiveTurnStatus {
  if (!model) return EMPTY_STATUS;
  const cached = statusByModel.get(model);
  if (cached) return cached;
  const result = deriveStatus(model);
  statusByModel.set(model, result);
  return result;
}

function deriveStatus(model: TurnModel): LiveTurnStatus {
  const lastTurn = model.turns[model.turns.length - 1];
  if (!lastTurn) return EMPTY_STATUS;

  // The latest todo list wins outright, even when it has no in-progress item:
  // the list is the harness's own current statement of the plan, and reaching
  // further back would resurrect a todo the harness has since replaced.
  let todo: LiveTurnStatus['todo'];
  outer: for (let t = model.turns.length - 1; t >= 0; t--) {
    const turn = model.turns[t];
    if (!turn) continue;
    for (let i = turn.entryIds.length - 1; i >= 0; i--) {
      const entry = model.entries[turn.entryIds[i] ?? ''];
      if (!entry || entry.duplicate) continue;
      if (entry.kind !== 'tool_call' && entry.kind !== 'tool_result') continue;
      if (entry.toolName !== 'TodoWrite' || entry.toolInput === undefined) continue;
      const text = inProgressTodoText(entry.toolInput);
      if (text) todo = { text: truncate(text), sinceTs: entry.ts };
      break outer;
    }
  }

  // Tasks first, so their tool_use_ids can claim the Task tool calls that
  // spawned them. A settled task still claims its call: the call's result may
  // land an event later, and in that gap the turn is "composing", not "waiting".
  // Claims are matched by TOOL ID, not entry key — the live reducer keys a call
  // `tool_<tool_id>` but the server-materialized page keys it `e_<eventId>`, and
  // a claim written against the key shape would silently miss on one of them.
  const subagentByTaskId = new Map<string, LiveSubagent>();
  const claimedToolUseIds = new Set<string>();
  for (const entryId of lastTurn.entryIds) {
    const entry = model.entries[entryId];
    if (!entry || entry.duplicate || entry.kind !== 'system' || !entry.taskId) continue;
    if (entry.subtype === 'task_started') {
      if (entry.toolUseId) claimedToolUseIds.add(entry.toolUseId);
      if (!subagentByTaskId.has(entry.taskId)) {
        subagentByTaskId.set(entry.taskId, {
          taskId: entry.taskId,
          description: entry.text ?? '',
          subagentType: entry.subagentType,
          taskType: entry.taskType,
          startedAt: entry.ts,
        });
      }
    } else if (entry.subtype === 'task_progress') {
      const task = subagentByTaskId.get(entry.taskId);
      if (task && entry.lastToolName) task.lastToolName = entry.lastToolName;
    } else if (isTerminalTaskStatus(entry.taskStatus)) {
      subagentByTaskId.delete(entry.taskId);
    }
  }

  // Results this turn, by tool id — the pairing the server-materialized page
  // needs. The live reducer merges a result onto its call (`toolResult` set), but
  // a cold-loaded page keeps them as two rows, and reading `toolResult` alone
  // would report every historical call as still running.
  const lastTurnEntries: Entry[] = [];
  for (const entryId of lastTurn.entryIds) {
    const entry = model.entries[entryId];
    if (entry && !entry.duplicate) lastTurnEntries.push(entry);
  }
  const resulted = resultedToolIds(lastTurnEntries);

  const toolCalls: LiveToolCall[] = [];
  let lastEntryTs: string | undefined;
  for (const entry of lastTurnEntries) {
    lastEntryTs = entry.ts;
    if (entry.kind !== 'tool_call') continue;
    // In flight = no result yet, on either model shape. A call with no tool id
    // can never receive one (the reducer marks these `unpairable`; the server
    // materializer marks nothing, so the absent id is read directly) — it must
    // not render as pending: it is not pending, it is unknowable.
    if (entry.toolResult !== undefined || entry.unpairable) continue;
    const toolId = toolIdOf(entry);
    if (!toolId || resulted.has(toolId)) continue;
    if (claimedToolUseIds.has(toolId)) continue;
    toolCalls.push({
      name: entry.toolName ?? '',
      summary: toolCallSummary(entry.toolName, entry.toolInput),
      startedAt: entry.ts,
    });
  }

  return { todo, toolCalls, subagents: [...subagentByTaskId.values()], lastEntryTs };
}

/**
 * Attach each live subagent's promoted bridge session, joining on
 * `harnessSessionId === "agent-" + taskId` — the id the server mints the
 * subagent session with, derived from the task id so the two records converge.
 * A task with no promoted session (a backgrounded shell, or a server that
 * predates promotion) keeps `sessionId` undefined. Returns the input array
 * untouched when nothing joins, so memoized callers keep their reference.
 */
export function joinSubagentSessions(
  subagents: LiveSubagent[],
  sessions: Map<string, SessionSummary>,
): LiveSubagent[] {
  if (subagents.length === 0) return subagents;
  const sessionIdByHarnessId = new Map<string, string>();
  for (const summary of sessions.values()) {
    if (summary.harnessSessionId) {
      sessionIdByHarnessId.set(summary.harnessSessionId, summary.sessionId);
    }
  }
  let joined: LiveSubagent[] | undefined;
  subagents.forEach((task, index) => {
    const sessionId = sessionIdByHarnessId.get(`agent-${task.taskId}`);
    if (!sessionId) return;
    if (!joined) joined = [...subagents];
    joined[index] = { ...task, sessionId };
  });
  return joined ?? subagents;
}
