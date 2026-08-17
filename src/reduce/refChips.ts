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
//
// Three grammars are recognised, all by one regex: bare session ids, a cue word
// in front of a noteboard uuid, and the producer/orchestrator's `[kind:id]`
// bracket dialect (added here, not present upstream).

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

// The producer/orchestrator writes references in its own bracket dialect —
// `[session:…]`, `[todo:…]`, `[note:…]`, `[task:…]` — where the brackets and the
// kind prefix are part of the token, not prose around it. Matched whole and
// consumed whole, so nothing of `[kind:` or `]` survives as stray literal text.
//
// Inside `[session:…]` the id is NOT required to look like SESSION_ID: the
// producer emits harness session ids there too, which are uuids or other opaque
// strings. Anything without whitespace or a closing bracket is taken verbatim.
// The bracket + kind prefix is what disambiguates, so no shape check is needed.
const BRACKET_SESSION_ID = String.raw`[^\]\s]+`;

// The noteboard-backed bracket kinds. Unlike the session form these DO require a
// uuid: an unconstrained id here would chip ordinary prose like `[todo:done]`,
// and every noteboard item id is a uuid anyway.
//
// `task` is the producer's word for a kanban card, and a kanban card id IS a
// noteboard item id — kanban-store owns only where a card sits, noteboard owns
// what it says — so `[task:…]` resolves through the same noteboard lookup as a
// todo and is therefore given kind `todo`, not a kind of its own.
const BRACKET_ITEM_KIND = String.raw`todo|note|task`;

// A markdown link is `[text](url)`, so a bracket token immediately followed by
// `(` is a link label and must stay literal — otherwise `[session:x](http://…)`
// loses its address to a chip.
const NOT_A_LINK_LABEL = String.raw`(?!\()`;

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
 *  chip's placeholder label before the real `type` arrives. Also serves the
 *  bracket dialect's kind words, where it is what maps `task` onto `todo`. */
function kindForCue(cue: string): RefKind {
  return NOTE_CUE_WORDS.has(cue.toLowerCase()) ? 'note' : 'todo';
}

// Group layout:
//   1 = bracket session id      (`[session:<id>]`, id taken verbatim)
//   2 = bracket item kind word  3 = bracket item uuid  (`[todo|note|task:<uuid>]`)
//   4 = bare session id (whole match is the chip)
//   5 = item cue word    6 = separator    7 = item uuid
//
// The bracket alternatives come FIRST so a bracket token is consumed whole. They
// start one character earlier than the cue alternative would (at `[` rather than
// at the kind word), so leftmost-match already prefers them — but keeping them
// ahead makes that independent of the scan position, and `[todo:<uuid>]` can
// never come out as a cue match plus two leftover literals.
function newTokenRe(): RegExp {
  return new RegExp(
    String.raw`\[session:(${BRACKET_SESSION_ID})\]${NOT_A_LINK_LABEL}` +
      String.raw`|\[(${BRACKET_ITEM_KIND}):(${UUID})\]${NOT_A_LINK_LABEL}` +
      String.raw`|\b(${SESSION_ID})\b` +
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
    if (match[1] !== undefined) {
      // `[session:<id>]` — brackets and prefix are part of the token, so the
      // whole match is replaced by the chip and nothing literal is left behind.
      out.push({ type: 'chip', kind: 'session', refId: match[1] });
    } else if (match[2] !== undefined) {
      // `[todo|note|task:<uuid>]` — same, and `task` maps to `todo` because a
      // kanban card id is a noteboard item id (see BRACKET_ITEM_KIND).
      out.push({ type: 'chip', kind: kindForCue(match[2]), refId: match[3] ?? '' });
    } else if (match[4] !== undefined) {
      out.push({ type: 'chip', kind: 'session', refId: match[4] });
    } else {
      // Keep the cue word + separator as plain text; chip only the uuid.
      out.push({ type: 'text', value: (match[5] ?? '') + (match[6] ?? '') });
      out.push({ type: 'chip', kind: kindForCue(match[5] ?? ''), refId: match[7] ?? '' });
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
/** A single-backtick span. A LEAF with a `value`, like `code` (the fenced
 *  block) — the two are only distinguishable by `type`, which is why the fenced
 *  case has to be excluded by name rather than by shape. */
interface MdInlineCode {
  type: 'inlineCode';
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
type MdNode = MdText | MdInlineCode | RefChipNode | MdParent;

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

/**
 * remark-compatible transformer. Rewrites bare session ids, cue-prefixed
 * noteboard uuids and the producer's `[kind:id]` bracket tokens into
 * `<ref-chip>` elements, and never re-scans what it inserted. Dependency-free:
 * it walks the tree itself rather than using unist-util-visit.
 *
 * Two node types are treated as verbatim and left alone, for opposite reasons:
 *
 *  - `link` — a linkified id keeps its link. Only remark-gfm's autolink-literal
 *    extension makes a bare pasted URL a link node, so without gfm in the
 *    pipeline an id in a URL's query string is cut out of the middle of the
 *    address.
 *  - `code` — a FENCED block holds a payload: a curl command, a JSON body, a log
 *    line. Chipping inside one would corrupt what a reader copies out of it.
 *
 * `inlineCode` is deliberately NOT in that list. A single-backtick span is prose
 * emphasis, not a payload, and setting an id apart with backticks is the most
 * natural way to write one — so those resolve. Getting this wrong is invisible
 * rather than loud: the id simply renders as text and looks like a chip that
 * failed, which is exactly how it was first reported.
 */
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
        if (node.type === 'inlineCode') {
          const segments = parseRefChips((node as MdInlineCode).value);
          if (!segments.some((s) => s.type === 'chip')) continue;
          // Whatever was NOT a reference stays code — `todo: <uuid>` in backticks
          // becomes a code span reading "todo: " followed by the chip, rather
          // than losing the code styling the author asked for. Whitespace-only
          // leftovers become plain text: an empty code span would render as a
          // stray tick-mark box.
          const replacement: MdNode[] = segments.map((s) =>
            s.type === 'chip'
              ? chip(s.kind, s.refId)
              : s.value.trim() === ''
                ? { type: 'text', value: s.value }
                : { type: 'inlineCode', value: s.value },
          );
          parent.children.splice(i, 1, ...replacement);
          i += replacement.length - 1;
          continue;
        }
        if (isParent(node)) walk(node);
      }
    };
    walk(tree);
  };
}
