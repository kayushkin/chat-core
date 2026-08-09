// Ported from bridge-ui `components/chat/refChips/remarkRefChips.ts`. The pure
// detection logic — which bare tokens in a message become reference chips — is
// lifted verbatim; the framework-heavy bits (react-markdown wiring) are dropped.
//
// Two entrypoints:
//  - `parseRefChips(text)` — the dependency-free core: splits a string into an
//    ordered list of plain-text and ref-chip segments. This is what a
//    framework-light renderer consumes.
//  - `remarkRefChips()` — a remark-compatible transformer over an mdast tree,
//    rewriting text nodes into `<ref-chip>` hast elements, matching bridge-ui's
//    behavior for consumers that already run react-markdown. It uses the same
//    core matcher and imports nothing, so chat-core stays dependency-free.

/**
 * Which backend a chip queries.
 *
 * `session` resolves against llm-bridge; `note` and `todo` both resolve against
 * noteboard, which stores them in ONE id space alongside `rank` and
 * `workspace`. So the note/todo split here is only which cue word was written
 * in front of the uuid — it is a hint about where to look, never a claim about
 * what the row is. The item's own `type` field is the authority, and a chip
 * labels itself from that once loaded (see NoteboardClient.getItem).
 */
export type RefKind = 'session' | 'note' | 'todo';

/** An ordered piece of a parsed message: literal text or a detected reference. */
export type RefSegment =
  | { type: 'text'; value: string }
  | { type: 'chip'; kind: RefKind; refId: string };

// Bridge session ids are unambiguous on their own, so they are linkified
// wherever they appear:
//   - br_<16-19 digit snowflake>                    (interactive/frontend)
//   - herald-<snowflake>, herald-a-b-<snowflake>    (Herald ask sessions)
//   - autoworker-<segments>-<snowflake>             (autoworker sessions)
// Noteboard item ids (notes, todos, workspaces — one id space) are plain UUIDs,
// which collide with harness session UUIDs and other unrelated uuids, so an item
// is linkified ONLY when a cue word (note / todo / item / card / workspace,
// optionally with an _id suffix) immediately precedes it. The cue word itself is
// left as plain text; only the uuid becomes a chip.
const SESSION_ID = String.raw`br_\d{16,19}|(?:herald|autoworker)(?:-[a-z0-9]+)*-\d{16,19}`;
const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

// Cue words, longest-first WITHIN each group: alternation is ordered, and with
// `todo` ahead of `todo_id` the shorter one wins and the separator class (which
// has no underscore) then fails to match `_id`, killing the whole alternative.
const NOTE_CUE = String.raw`note_id|workspace_id|note|workspace`;
const TODO_CUE = String.raw`todo_id|item_id|card_id|todo|item|card`;
const ITEM_CUE = `${NOTE_CUE}|${TODO_CUE}`;

// Which cue words mean "look this up as a note". A set, not a chain of
// comparisons, so adding a cue is one edit in one place. Kept lowercase because
// the matcher runs case-insensitively and may hand back "Note" or "TODO".
const NOTE_CUE_WORDS: ReadonlySet<string> = new Set([
  'note',
  'note_id',
  'workspace',
  'workspace_id',
]);

/** Which backend kind a matched cue word points at. Both note and todo cues
 *  resolve against the same noteboard endpoint; the kind only decides the
 *  chip's placeholder label before the real `type` arrives. */
function kindForCue(cue: string): RefKind {
  return NOTE_CUE_WORDS.has(cue.toLowerCase()) ? 'note' : 'todo';
}

// Group layout:
//   1 = session id (whole match is the chip)
//   2 = item cue word    3 = separator    4 = item uuid
function newTokenRe(): RegExp {
  return new RegExp(
    String.raw`\b(${SESSION_ID})\b` +
      String.raw`|\b(${ITEM_CUE})([\s:=#]{1,4})(${UUID})\b`,
    'gi',
  );
}

/** Pure core: split `value` into text + chip segments. Never throws; a string
 *  with no references returns a single text segment (or none, for an empty
 *  string). This is the same matcher bridge-ui's remark plugin runs, exposed as
 *  a framework-agnostic function so it is trivially testable and reusable. */
export function parseRefChips(value: string): RefSegment[] {
  const re = newTokenRe();
  const out: RefSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    if (match.index > last) {
      out.push({ type: 'text', value: value.slice(last, match.index) });
    }
    if (match[1]) {
      out.push({ type: 'chip', kind: 'session', refId: match[1] });
    } else {
      // Keep the cue word + separator as plain text; chip only the uuid.
      out.push({ type: 'text', value: (match[2] ?? '') + (match[3] ?? '') });
      out.push({ type: 'chip', kind: kindForCue(match[2] ?? ''), refId: match[4] ?? '' });
    }
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    out.push({ type: 'text', value: value.slice(last) });
  }
  return out;
}

// --- Minimal mdast shapes (typed locally to avoid a dependency on mdast). ---

interface MdText {
  type: 'text';
  value: string;
}
interface RefChipNode {
  type: 'refChip';
  data: { hName: 'ref-chip'; hProperties: { kind: RefKind; refId: string } };
  children: MdText[];
}
interface MdParent {
  type: string;
  children: MdNode[];
}
type MdNode = MdText | RefChipNode | MdParent;

function isParent(node: MdNode): node is MdParent {
  return Array.isArray((node as MdParent).children);
}

function chip(kind: RefKind, refId: string): RefChipNode {
  return {
    type: 'refChip',
    data: { hName: 'ref-chip', hProperties: { kind, refId } },
    children: [{ type: 'text', value: refId }],
  };
}

/** remark-compatible transformer. Rewrites bare session ids and cue-prefixed
 *  todo uuids inside text nodes into `<ref-chip>` elements, leaving text inside
 *  existing links alone and never re-scanning inserted nodes. Dependency-free:
 *  it walks the tree itself rather than using unist-util-visit. */
export function remarkRefChips() {
  return (tree: MdParent): void => {
    const walk = (parent: MdParent): void => {
      // `link` nodes keep their text verbatim (a linkified id keeps its link).
      if (parent.type === 'link') return;
      for (let i = 0; i < parent.children.length; i++) {
        const node = parent.children[i];
        if (node === undefined) continue;
        if (node.type === 'text') {
          const segments = parseRefChips((node as MdText).value);
          // Only rewrite when at least one chip was found.
          if (!segments.some((s) => s.type === 'chip')) continue;
          const replacement: MdNode[] = segments.map((s) =>
            s.type === 'text' ? { type: 'text', value: s.value } : chip(s.kind, s.refId),
          );
          parent.children.splice(i, 1, ...replacement);
          // Skip past the inserted nodes so their text is never re-scanned.
          i += replacement.length - 1;
          continue;
        }
        if (isParent(node)) walk(node);
      }
    };
    walk(tree);
  };
}
