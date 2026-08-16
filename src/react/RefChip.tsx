import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RefKind } from '../reduce/refChips.js';
import type { ManagedSessionDetail, TurnModel } from '../net/types.js';
import type { NoteboardItem } from '../net/NoteboardClient.js';
import {
  useNoteboardRefDetail,
  useSessionRefDetail,
  useSessionRefTranscript,
  REF_TRANSCRIPT_TURNS,
} from './refDetail.js';

/** Props for the {@link RefChip} renderer. When used as a ReactMarkdown custom
 *  component the mdast hProperties (`kind` / `refId`) arrive as props; rehype may
 *  lowercase the attribute, so `refid` is accepted too. Extra props are ignored. */
export interface RefChipProps {
  kind?: RefKind | string;
  refId?: string;
  /** Lowercased alias react-markdown/rehype may pass instead of `refId`. */
  refid?: string;
  className?: string;
  children?: ReactNode;
  /**
   * Navigate to the referenced thing — for a session, open its chat.
   *
   * Only kinds that HAVE a target invoke this: sessions do, noteboard items do
   * not (nothing on this fleet deep-links to one item), so a note or todo chip
   * opens its detail panel instead. That asymmetry is deliberate. The previous
   * arrangement called this for every kind and dash answered only `session`,
   * which left todo chips announcing themselves as buttons and doing nothing.
   */
  onActivate?: (kind: string, refId: string) => void;
  [key: string]: unknown;
}

/**
 * A reference chip: a bare session id or a cue-prefixed noteboard uuid, found in
 * message text by `remarkRefChips` and rendered here as a labelled chip with a
 * detail panel.
 *
 * Wire it into ReactMarkdown as the `ref-chip` component alongside
 * `remarkRefChips`:
 *
 *   <ReactMarkdown
 *     remarkPlugins={[remarkRefChips]}
 *     components={{ 'ref-chip': RefChip }}
 *   >{text}</ReactMarkdown>
 *
 * ⚠️ This component reads from `ChatProvider`'s context (it resolves the id
 * against llm-bridge or noteboard), so it must be mounted inside one. It used to
 * be a pure `<span>` that could stand alone; it is not anymore.
 *
 * Theming still stays at the edge. Every element carries a stable, unhashed
 * class name (`ref-chip-*`) and `data-*` attributes, and this file ships no CSS
 * — the host styles it, as dash does in `DashV2.module.css` via `:global()`.
 */
export function RefChip(props: RefChipProps): JSX.Element {
  const kind = String(props.kind ?? 'session');
  const refId = String(props.refId ?? props.refid ?? '');

  // A malformed node with no id resolves to nothing; render the raw text rather
  // than an empty chip so the message loses no content.
  if (!refId) return <>{String(props.children ?? '')}</>;

  return kind === 'session' ? (
    <SessionRefChip refId={refId} className={props.className} onActivate={props.onActivate} />
  ) : (
    <NoteboardRefChip refId={refId} kind={kind} className={props.className} />
  );
}

/** Gap in px between the chip and its panel, and the margin the panel keeps
 *  from the viewport edge when it has to be nudged back inside. */
const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Open/close plus placement for the detail panel.
 *
 * ⚠️ The panel is rendered through a PORTAL onto document.body, and that is
 * load-bearing rather than stylistic. dash renders turns through `virtua`,
 * whose list-item wrapper carries `contain: layout style` — which creates a
 * stacking context. A panel positioned inside that item therefore has its
 * `z-index` scoped to the item, and the very next turn's prose paints straight
 * over it: measured, the element at the panel's own centre point was a later
 * turn's `<p>`, so the buttons could be seen and not clicked. No z-index on the
 * panel can fix that from inside the containing block; escaping it can. The
 * portal also escapes the scroll container's `overflow`, which would otherwise
 * clip a panel opened on the last visible turn.
 *
 * The cost of the portal is that placement becomes manual: the panel is
 * `position: fixed` and anchored to the chip's measured rect, re-measured on
 * scroll and resize. `capture: true` on the scroll listener is required — the
 * turns list is an inner scroller and scroll events do not bubble to window.
 */
function useAnchoredPanel(): {
  open: boolean;
  toggle: () => void;
  wrapRef: React.RefObject<HTMLSpanElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  panelStyle: { top: number; left: number } | null;
} {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return;
    }
    const place = (): void => {
      const anchor = wrapRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      // Measured when it exists; on the first pass it does not, and the fallback
      // only has to be close enough to avoid a visible jump.
      const panelHeight = panelRef.current?.offsetHeight ?? 260;
      const panelWidth = panelRef.current?.offsetWidth ?? 280;

      // Below the chip, unless that would run off the bottom and there is more
      // room above — the usual dropdown flip.
      const roomBelow = window.innerHeight - rect.bottom;
      const roomAbove = rect.top;
      const placeAbove = roomBelow < panelHeight + VIEWPORT_MARGIN && roomAbove > roomBelow;
      const rawTop = placeAbove ? rect.top - panelHeight - PANEL_GAP : rect.bottom + PANEL_GAP;

      const maxTop = window.innerHeight - panelHeight - VIEWPORT_MARGIN;
      const maxLeft = window.innerWidth - panelWidth - VIEWPORT_MARGIN;
      setPanelStyle({
        top: Math.max(VIEWPORT_MARGIN, Math.min(rawTop, Math.max(VIEWPORT_MARGIN, maxTop))),
        left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, Math.max(VIEWPORT_MARGIN, maxLeft))),
      });
    };

    place();
    // capture:true — the turns list scrolls internally and its scroll events
    // never reach window on the bubble phase.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      // The panel is no longer a descendant of the wrapper, so "outside" has to
      // clear BOTH or every click inside the panel would close it.
      const insideChip = wrapRef.current?.contains(target) ?? false;
      const insidePanel = panelRef.current?.contains(target) ?? false;
      if (!insideChip && !insidePanel) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return { open, toggle: () => setOpen((o) => !o), wrapRef, panelRef, panelStyle };
}

/** The portaled panel shell. Kept in one place so both chips share the
 *  placement, the ref wiring and the dialog semantics. */
function AnchoredPanel({
  panelRef,
  panelStyle,
  label,
  refId,
  refKind,
  children,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  panelStyle: { top: number; left: number } | null;
  label: string;
  refId: string;
  refKind: string;
  children: ReactNode;
}): JSX.Element {
  return createPortal(
    <div
      ref={panelRef}
      className="ref-chip-panel"
      role="dialog"
      aria-label={label}
      // The portal puts this at the end of <body>, far from the chip it belongs
      // to, so it carries the same identifying attributes as the chip wrapper.
      // Without them the DOM cannot say which reference an open panel describes.
      data-ref-id={refId}
      data-ref-kind={refKind}
      // Placement is inline because it is measured, not themeable. Everything
      // else about the panel's appearance stays in the host's stylesheet.
      // `visibility` hides the first, unmeasured paint rather than letting it
      // flash at the wrong place.
      style={{
        top: panelStyle?.top ?? 0,
        left: panelStyle?.left ?? 0,
        visibility: panelStyle ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function truncate(s: string, n = 28): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Last `n` characters of an id, for a chip whose target has no name yet. */
function idTail(id: string, n = 12): string {
  return id.length > n ? `…${id.slice(-n)}` : id;
}

/** Relative time, for rows where "how long ago" is the question. Falls back to
 *  the raw string when the timestamp does not parse — never to "now", which
 *  would be a fabricated answer. */
function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);
  const [value, unit] =
    abs < 60
      ? [abs, 'second']
      : abs < 3600
        ? [Math.round(abs / 60), 'minute']
        : abs < 86400
          ? [Math.round(abs / 3600), 'hour']
          : [Math.round(abs / 86400), 'day'];
  const plural = value === 1 ? '' : 's';
  return future ? `in ${value} ${unit}${plural}` : `${value} ${unit}${plural} ago`;
}

function formatUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? `<$0.01` : `$${usd.toFixed(2)}`;
}

/**
 * The chip's emoji, categorizing a session the way the filter bar does: by
 * stored `type`, refined with `purpose` and the id prefix — herald and
 * autoworker are purposes of an autonomous session, not distinct types.
 * `external` means the session ran outside the bridge and was imported by
 * scanning harness history, so nobody declared a purpose and it must not read
 * as a human chat.
 */
function sessionEmoji(type: string, purpose: string, sessionId: string): string {
  if (type === 'herald' || purpose === 'herald' || sessionId.startsWith('herald-')) return '📣';
  if (purpose === 'autoworker' || sessionId.startsWith('autoworker-')) return '🤖';
  if (type === 'interactive') return '💬';
  if (type === 'system') return '⚙️';
  if (type === 'autonomous') return '🛠️';
  if (type === 'external') return '📥';
  return '🔗';
}

/** The "needs a human" states, badged so a waiting question stands out. */
const STATE_BADGES: ReadonlyMap<string, string> = new Map([
  ['awaiting_user', 'question'],
  ['awaiting_permission', 'approval'],
]);

// ---------------------------------------------------------------------------
// Session chip
// ---------------------------------------------------------------------------

function SessionRefChip({
  refId,
  className,
  onActivate,
}: {
  refId: string;
  className?: string;
  onActivate?: (kind: string, refId: string) => void;
}): JSX.Element {
  const { open, toggle, wrapRef, panelRef, panelStyle } = useAnchoredPanel();
  const { data, error, loading } = useSessionRefDetail(refId);

  const summary = data?.summary;
  const emoji = summary ? sessionEmoji(summary.type, summary.purpose, refId) : '💬';
  const label = summary?.displayName ? truncate(summary.displayName) : idTail(refId);
  // No handler means no navigation target, so the chip body falls back to the
  // panel rather than being an inert button.
  const activate = onActivate ? () => onActivate('session', refId) : toggle;

  return (
    <span className="ref-chip-wrap" ref={wrapRef} data-ref-kind="session" data-ref-id={refId}>
      <button
        type="button"
        className={className ?? 'ref-chip ref-chip-session'}
        onClick={activate}
        title={onActivate ? `Open chat — ${summary?.displayName || refId}` : refId}
      >
        <span className="ref-chip-glyph" aria-hidden>
          {emoji}
        </span>
        <span className="ref-chip-label">{label}</span>
      </button>
      <button
        type="button"
        className={`ref-chip-caret${open ? ' ref-chip-open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label="Session details"
        title="Details"
      >
        ▾
      </button>
      {open && (
        <AnchoredPanel
          panelRef={panelRef}
          panelStyle={panelStyle}
          label="Session details"
          refId={refId}
          refKind="session"
        >
          {loading && <div className="ref-chip-panel-loading">Loading session…</div>}
          {error && <div className="ref-chip-panel-error">Couldn’t load session: {error}</div>}
          {data && <SessionRefPanel detail={data} refId={refId} onActivate={onActivate} />}
        </AnchoredPanel>
      )}
    </span>
  );
}

function SessionRefPanel({
  detail,
  refId,
  onActivate,
}: {
  detail: ManagedSessionDetail;
  refId: string;
  onActivate?: (kind: string, refId: string) => void;
}): JSX.Element {
  const [showHistory, setShowHistory] = useState(false);
  const { summary, info } = detail;

  return (
    <>
      <div className="ref-chip-panel-title">{summary.displayName || '(untitled session)'}</div>

      <RefRow label="State" value={summary.state} badge={STATE_BADGES.get(summary.state)} />
      <RefRow
        label="Type"
        value={summary.purpose ? `${summary.type} · ${summary.purpose}` : summary.type}
      />
      {summary.harness !== '' && <RefRow label="Harness" value={summary.harness} />}
      {info?.model && <RefRow label="Model" value={info.model} />}
      {info?.permissionMode && <RefRow label="Permissions" value={info.permissionMode} />}
      {summary.mode !== '' && <RefRow label="Mode" value={summary.mode} />}
      {summary.folderName !== '' && <RefRow label="Folder" value={summary.folderName} />}
      {summary.instanceId !== '' && <RefRow label="Instance" value={summary.instanceId} />}
      {/* Working dir is reported in two places and they can disagree: the
          harness's own view (`info.workingDir`) and the managed session's
          (`detail.workingDir`). Prefer the harness's, which is where the agent
          is actually running. */}
      {(info?.workingDir ?? detail.workingDir) && (
        <RefRow label="Working dir" value={(info?.workingDir ?? detail.workingDir) as string} />
      )}
      {detail.origin && <RefRow label="Origin" value={detail.origin} />}
      {detail.pid !== undefined && <RefRow label="PID" value={String(detail.pid)} />}
      {/* Spend is reported, never derived. An absent figure means the server
          sent none, which is not the same as zero, so no row is drawn. */}
      {detail.spendUsd !== undefined && (
        <RefRow
          label="Spend"
          value={
            detail.maxBudgetUsd !== undefined
              ? `${formatUsd(detail.spendUsd)} of ${formatUsd(detail.maxBudgetUsd)}`
              : formatUsd(detail.spendUsd)
          }
        />
      )}
      {detail.forkedFromSessionId && (
        <RefRow label="Forked from" value={idTail(detail.forkedFromSessionId, 14)} />
      )}
      {detail.managerSessionId && (
        <RefRow label="Manager" value={idTail(detail.managerSessionId, 14)} />
      )}
      {info?.tools && info.tools.length > 0 && (
        <RefRow label="Tools" value={String(info.tools.length)} />
      )}
      {info?.mcpServers && info.mcpServers.length > 0 && (
        <RefRow label="MCP" value={info.mcpServers.map((s) => s.name).join(', ')} />
      )}
      {info?.skills && info.skills.length > 0 && (
        <RefRow label="Skills" value={info.skills.join(', ')} />
      )}
      <RefRow label="Created" value={timeAgo(summary.createdAt)} />
      <RefRow label="Updated" value={timeAgo(summary.updatedAt)} />

      <div className="ref-chip-panel-actions">
        <button
          type="button"
          className="ref-chip-panel-btn"
          onClick={() => setShowHistory((v) => !v)}
          aria-expanded={showHistory}
        >
          {showHistory ? 'Hide history' : `Load last ${REF_TRANSCRIPT_TURNS} turns`}
        </button>
        {onActivate && (
          <button
            type="button"
            className="ref-chip-panel-btn"
            onClick={() => onActivate('session', refId)}
          >
            Open session
          </button>
        )}
      </div>

      {/* Mounted only while expanded, which is also what gates the fetch. */}
      {showHistory && <SessionRefTranscript refId={refId} />}
    </>
  );
}

function SessionRefTranscript({ refId }: { refId: string }): JSX.Element {
  const { data, error, loading } = useSessionRefTranscript(refId, true);

  if (loading) return <div className="ref-chip-panel-loading">Loading history…</div>;
  if (error) return <div className="ref-chip-panel-error">Couldn’t load history: {error}</div>;
  if (!data) return <div className="ref-chip-panel-loading">No history.</div>;
  return <TranscriptBody model={data} />;
}

/**
 * The referenced session's recent turns, as plain text.
 *
 * Deliberately NOT markdown: chat-core carries no markdown renderer (dash owns
 * that pipeline, with its own plugins), and reaching for one here would both add
 * a dependency this package refuses and risk recursion — a transcript rendered
 * through `remarkRefChips` would linkify the ids inside it into more chips, each
 * able to load another transcript.
 */
function TranscriptBody({ model }: { model: TurnModel }): JSX.Element {
  const rows = model.turns.map((turn) => {
    // The collapsed view's rule: primary, non-duplicate entries only, so an
    // OTel copy of a message does not print twice.
    const text = turn.entryIds
      .map((id) => model.entries[id])
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .filter((e) => !e.duplicate && e.primary && e.kind === 'text' && e.text)
      .map((e) => e.text as string)
      .join('\n');
    return { id: turn.id, role: turn.role, ts: turn.ts, text };
  });
  const withText = rows.filter((r) => r.text !== '');

  return (
    <div className="ref-chip-transcript">
      {/* `more` is the server's own word for "older turns exist beyond this
          page". Said plainly, so a reader never mistakes this window for the
          whole session. */}
      {model.more && (
        <div className="ref-chip-transcript-note">
          Showing the last {REF_TRANSCRIPT_TURNS} turns — older ones exist. Open the session for
          the rest.
        </div>
      )}
      {withText.length === 0 && (
        <div className="ref-chip-panel-loading">No prose turns in this window.</div>
      )}
      {withText.map((r) => (
        <div key={r.id} className="ref-chip-transcript-turn" data-role={r.role}>
          <div className="ref-chip-transcript-role">
            {r.role} · {timeAgo(r.ts)}
          </div>
          <div className="ref-chip-transcript-text">{r.text}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Noteboard chip (note / todo / rank / workspace)
// ---------------------------------------------------------------------------

/** Emoji for a noteboard item. Held and deleted outrank the item's type,
 *  because they are what a reader most needs to know about a quoted id: a
 *  parked or deleted item is not work anyone should pick up. */
function itemEmoji(item: NoteboardItem): string {
  if (item.deleted_at) return '🗑';
  if (item.held_at) return '⏸';
  if (item.status === 'done') return '✅';
  if (item.type === 'note') return '📝';
  if (item.type === 'workspace') return '🧠';
  if (item.type === 'rank') return '🔢';
  return '☑';
}

function NoteboardRefChip({
  refId,
  kind,
  className,
}: {
  refId: string;
  kind: string;
  className?: string;
}): JSX.Element {
  const { open, toggle, wrapRef, panelRef, panelStyle } = useAnchoredPanel();
  const { data: item, error, loading } = useNoteboardRefDetail(refId);

  // The cue word only decided which regex matched; the loaded item's own `type`
  // is the authority, so the rendered kind switches to it as soon as it lands.
  const resolvedKind = item?.type ?? kind;
  const label = item?.title ? truncate(item.title) : idTail(refId);
  const emoji = item ? itemEmoji(item) : '☑';

  return (
    <span
      className="ref-chip-wrap"
      ref={wrapRef}
      data-ref-kind={resolvedKind}
      data-ref-id={refId}
    >
      {/* Nothing on this fleet deep-links to a single noteboard item, so the
          whole chip opens the panel rather than pretending to navigate. */}
      <button
        type="button"
        className={`${className ?? 'ref-chip'} ref-chip-item${open ? ' ref-chip-open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        title={`${resolvedKind} — ${item?.title || refId}`}
      >
        <span className="ref-chip-glyph" aria-hidden>
          {emoji}
        </span>
        <span className="ref-chip-label">{label}</span>
        <span className="ref-chip-caret-inline" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <AnchoredPanel
          panelRef={panelRef}
          panelStyle={panelStyle}
          label={`${resolvedKind} details`}
          refId={refId}
          refKind={resolvedKind}
        >
          {loading && <div className="ref-chip-panel-loading">Loading {kind}…</div>}
          {error && <div className="ref-chip-panel-error">Couldn’t load {kind}: {error}</div>}
          {item && <NoteboardRefPanel item={item} />}
        </AnchoredPanel>
      )}
    </span>
  );
}

function NoteboardRefPanel({ item }: { item: NoteboardItem }): JSX.Element {
  const [showBody, setShowBody] = useState(false);

  // Deleted and held are not statuses (noteboard keeps them as separate stamps
  // precisely so a restore can tell them apart), so they are badged onto the
  // status row rather than replacing its value.
  const statusBadge = item.deleted_at ? 'deleted' : item.held_at ? 'held' : undefined;

  return (
    <>
      <div className="ref-chip-panel-title">{item.title || '(untitled)'}</div>

      <RefRow label="Type" value={item.type} />
      <RefRow label="Status" value={item.status} badge={statusBadge} />
      {item.priority !== 0 && <RefRow label="Priority" value={String(item.priority)} />}
      {item.tags.length > 0 && <RefRow label="Tags" value={item.tags.join(', ')} />}
      {item.list_id !== '' && <RefRow label="List" value={item.list_id} />}
      {item.parent_id && <RefRow label="Parent" value={idTail(item.parent_id, 12)} />}
      {item.due_at && <RefRow label="Due" value={timeAgo(item.due_at)} />}
      {/* The rule, not a second due date — `due_at` above stays the answer to
          "when next". Shown because a recurring item behaves quite differently
          from a one-off and nothing else on the chip would say so. */}
      {item.schedule?.rrule && (
        <RefRow
          label="Repeats"
          value={
            item.schedule.tzid
              ? `${item.schedule.rrule} (${item.schedule.tzid})`
              : item.schedule.rrule
          }
        />
      )}
      {item.schedule?.remind?.nag && <RefRow label="Nags" value={item.schedule.remind.nag} />}
      {item.hold_reason && <RefRow label="Held because" value={item.hold_reason} />}
      {item.auto_hold_at_usd !== undefined && (
        <RefRow label="Spend ceiling" value={formatUsd(item.auto_hold_at_usd)} />
      )}
      {item.links.length > 0 && <RefRow label="Links" value={String(item.links.length)} />}
      {item.created_by !== '' && <RefRow label="Created by" value={item.created_by} />}
      <RefRow label="Created" value={timeAgo(item.created_at)} />
      <RefRow label="Updated" value={timeAgo(item.updated_at)} />

      {/* The body arrived with the item — one GET returns the whole row — so
          this expands what is already in hand and costs no request. */}
      {item.body !== '' && (
        <>
          <div className="ref-chip-panel-actions">
            <button
              type="button"
              className="ref-chip-panel-btn"
              onClick={() => setShowBody((v) => !v)}
              aria-expanded={showBody}
            >
              {showBody ? 'Hide body' : 'Show full body'}
            </button>
          </div>
          {showBody && <div className="ref-chip-item-body">{item.body}</div>}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function RefRow({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: string;
}): JSX.Element {
  return (
    <div className="ref-chip-panel-row">
      <span className="ref-chip-panel-label">{label}</span>
      <span className="ref-chip-panel-value">
        {value}
        {badge && <span className={`ref-chip-badge ref-chip-badge-${badge}`}>{badge}</span>}
      </span>
    </div>
  );
}
