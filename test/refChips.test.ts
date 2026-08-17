import { describe, expect, it } from 'vitest';
import { parseRefChips, remarkRefChips, type RefSegment } from '../src/reduce/refChips.js';

// This matcher had no test of its own until note support landed, which is why
// the note/todo cue split is pinned here in detail: the cue vocabulary is
// ordered alternation, and getting that order wrong fails silently (the chip
// simply does not appear) rather than throwing.

const UUID = '0d195aec-5ad0-4399-9b5d-75fe03262145';
const OTHER_UUID = 'aa1feef3-bd79-428d-a657-f01d418f526b';

function chips(text: string): Array<{ kind: string; refId: string }> {
  return parseRefChips(text)
    .filter((s): s is Extract<RefSegment, { type: 'chip' }> => s.type === 'chip')
    .map((s) => ({ kind: s.kind, refId: s.refId }));
}

function textOf(segments: RefSegment[]): string {
  return segments.map((s) => (s.type === 'text' ? s.value : `[${s.kind}:${s.refId}]`)).join('');
}

describe('parseRefChips — session ids', () => {
  it('chips a bare br_ snowflake', () => {
    expect(chips('see br_1234567890123456 for context')).toEqual([
      { kind: 'session', refId: 'br_1234567890123456' },
    ]);
  });

  it('chips herald and autoworker ids, including multi-segment names', () => {
    expect(chips('herald-1234567890123456 and autoworker-repo-guard-1234567890123456')).toEqual([
      { kind: 'session', refId: 'herald-1234567890123456' },
      { kind: 'session', refId: 'autoworker-repo-guard-1234567890123456' },
    ]);
  });

  it('leaves a too-short snowflake alone', () => {
    expect(chips('br_123')).toEqual([]);
  });
});

describe('parseRefChips — noteboard cues', () => {
  it('needs a cue word: a bare uuid is never a chip', () => {
    // Noteboard ids are plain uuids and collide with harness session uuids and
    // unrelated ones, so chipping them unprompted would linkify noise.
    expect(chips(`the id is ${UUID}`)).toEqual([]);
  });

  it('maps todo-family cues to the todo kind', () => {
    for (const cue of ['todo', 'item', 'card', 'todo_id', 'item_id', 'card_id']) {
      expect(chips(`${cue}: ${UUID}`)).toEqual([{ kind: 'todo', refId: UUID }]);
    }
  });

  it('maps note-family cues to the note kind', () => {
    for (const cue of ['note', 'workspace', 'note_id', 'workspace_id']) {
      expect(chips(`${cue}: ${UUID}`)).toEqual([{ kind: 'note', refId: UUID }]);
    }
  });

  it('matches the _id form whole rather than the short cue plus a stray tail', () => {
    // Alternation is ordered. With `note` ahead of `note_id`, the short cue wins,
    // the separator class (no underscore) then cannot match `_id`, and the whole
    // alternative dies — the chip vanishes with no error anywhere.
    expect(textOf(parseRefChips(`note_id=${UUID}`))).toBe(`note_id=[note:${UUID}]`);
  });

  it('accepts every separator in the class, and rejects others', () => {
    for (const sep of [' ', ':', '=', '#', ': ', ' = ']) {
      expect(chips(`todo${sep}${UUID}`)).toEqual([{ kind: 'todo', refId: UUID }]);
    }
    // An underscore is not a separator, so this is just a word before a uuid.
    expect(chips(`todo_${UUID}`)).toEqual([]);
  });

  it('is case-insensitive about the cue but keeps the id verbatim', () => {
    expect(chips(`TODO: ${UUID}`)).toEqual([{ kind: 'todo', refId: UUID }]);
    expect(chips(`Note: ${UUID}`)).toEqual([{ kind: 'note', refId: UUID }]);
  });

  it('keeps the cue word as plain text and chips only the uuid', () => {
    expect(textOf(parseRefChips(`see todo: ${UUID} please`))).toBe(
      `see todo: [todo:${UUID}] please`,
    );
  });

  it('does not fire on a word that merely ends with a cue', () => {
    // `\b` guards the left edge: "footnote" must not read as "note".
    expect(chips(`footnote ${UUID}`)).toEqual([]);
    expect(chips(`notes ${UUID}`)).toEqual([]);
  });

  it('handles several references of mixed kinds in one string', () => {
    expect(chips(`br_1234567890123456 fixed todo ${UUID}, see note ${OTHER_UUID}`)).toEqual([
      { kind: 'session', refId: 'br_1234567890123456' },
      { kind: 'todo', refId: UUID },
      { kind: 'note', refId: OTHER_UUID },
    ]);
  });
});

describe('parseRefChips — producer bracket dialect', () => {
  // The producer/orchestrator writes `[kind:id]`, brackets and all. Before this
  // was understood the bare id chipped and the literal `[session:` and `]` were
  // left stranded on either side of it, which reads as a rendering bug.

  it('chips [session:…] and consumes the brackets and prefix', () => {
    expect(chips('[session:br_1786996794975654882]')).toEqual([
      { kind: 'session', refId: 'br_1786996794975654882' },
    ]);
    expect(textOf(parseRefChips('[session:br_1786996794975654882]'))).toBe(
      '[session:br_1786996794975654882]',
    );
    // textOf renders a chip in the same bracket shape, so pin the SEGMENTS too:
    // exactly one, a chip, with no literal text on either side.
    expect(parseRefChips('[session:br_1786996794975654882]')).toEqual([
      { type: 'chip', kind: 'session', refId: 'br_1786996794975654882' },
    ]);
  });

  it('accepts any opaque id inside [session:…], not just a snowflake', () => {
    // Harness session ids are uuids or other opaque strings. The bracket and the
    // kind prefix are what disambiguate, so no shape check is applied.
    expect(chips(`[session:${UUID}]`)).toEqual([{ kind: 'session', refId: UUID }]);
    expect(chips('[session:sess_abc.123/xyz]')).toEqual([
      { kind: 'session', refId: 'sess_abc.123/xyz' },
    ]);
  });

  it('chips [todo:…] and [note:…] with no stray literals', () => {
    expect(parseRefChips(`[todo:${UUID}]`)).toEqual([
      { type: 'chip', kind: 'todo', refId: UUID },
    ]);
    expect(parseRefChips(`[note:${UUID}]`)).toEqual([
      { type: 'chip', kind: 'note', refId: UUID },
    ]);
  });

  it('reads [task:…] as a todo, because a kanban card id IS a noteboard item id', () => {
    // kanban-store owns only where a card sits; noteboard owns what it says, so
    // the producer's `task` resolves through the same lookup as a todo.
    expect(parseRefChips(`[task:${UUID}]`)).toEqual([
      { type: 'chip', kind: 'todo', refId: UUID },
    ]);
  });

  it('produces exactly ONE chip for [todo:…], not a chip plus leftovers', () => {
    // The cue alternative also matches `todo:<uuid>` inside those brackets. If it
    // won, the result would be text('[todo:') + chip + text(']').
    expect(parseRefChips(`[todo:${UUID}]`)).toHaveLength(1);
  });

  it('surrounds a bracket token with plain prose only', () => {
    expect(parseRefChips(`fixed [task:${UUID}] today`)).toEqual([
      { type: 'text', value: 'fixed ' },
      { type: 'chip', kind: 'todo', refId: UUID },
      { type: 'text', value: ' today' },
    ]);
  });

  it('handles several bracket tokens of mixed kinds in one string', () => {
    expect(
      chips(`[session:br_1234567890123456] closed [task:${UUID}] and [note:${OTHER_UUID}]`),
    ).toEqual([
      { kind: 'session', refId: 'br_1234567890123456' },
      { kind: 'todo', refId: UUID },
      { kind: 'note', refId: OTHER_UUID },
    ]);
  });

  it('is case-insensitive about the bracket kind word', () => {
    expect(chips(`[TASK:${UUID}]`)).toEqual([{ kind: 'todo', refId: UUID }]);
    expect(chips('[Session:br_1234567890123456]')).toEqual([
      { kind: 'session', refId: 'br_1234567890123456' },
    ]);
  });

  it('leaves the bare-id and cue grammars untouched', () => {
    // Same ids without brackets still behave exactly as before.
    expect(textOf(parseRefChips(`todo: ${UUID}`))).toBe(`todo: [todo:${UUID}]`);
    expect(chips('br_1234567890123456')).toEqual([
      { kind: 'session', refId: 'br_1234567890123456' },
    ]);
  });

  it('does not chip markdown link syntax', () => {
    // `[text](url)` is a link label, not a reference token.
    expect(chips('[the session](http://example.com/x)')).toEqual([]);
    expect(chips('[session:x](http://example.com/s/x)')).toEqual([]);
    expect(parseRefChips('[session:x](http://example.com/s/x)')).toEqual([
      { type: 'text', value: '[session:x](http://example.com/s/x)' },
    ]);
  });

  it('still applies the OLD cue grammar inside a link label, as it always did', () => {
    // `[todo:<uuid>](url)` is refused as a BRACKET token — no `[todo:` or `]` is
    // consumed — but the cue alternative then matches `todo:<uuid>` inside the
    // label exactly as it did before the bracket dialect existed. Left alone on
    // purpose: the pure parser's cue grammar is unchanged, and in the real mdast
    // pipeline a link label lives in a `link` node, which the walk skips.
    expect(textOf(parseRefChips(`[todo:${UUID}](http://example.com/t)`))).toBe(
      `[todo:[todo:${UUID}]](http://example.com/t)`,
    );
  });

  it('leaves malformed bracket forms as plain text', () => {
    for (const bad of [
      '[session:]',
      '[:id]',
      '[unknown:id]',
      `[unknown:${UUID}]`,
      '[session]',
    ]) {
      expect(chips(bad), bad).toEqual([]);
    }
  });

  it('falls back to the bare-id grammar when the closing bracket is missing', () => {
    // Not a bracket token, so the brackets and prefix stay literal — but the id
    // itself is still unambiguous on its own and chips as it always did.
    expect(textOf(parseRefChips('[session:br_1234567890123456'))).toBe(
      '[session:[session:br_1234567890123456]',
    );
  });

  it('requires a uuid for the noteboard bracket kinds', () => {
    // An unconstrained id here would chip ordinary prose, and every noteboard
    // item id is a uuid anyway.
    expect(chips('[todo:done]')).toEqual([]);
    expect(chips('[note:1]')).toEqual([]);
  });

  it('does not let a bracket token swallow whitespace or a stray bracket', () => {
    expect(chips(`[todo: ${UUID}]`)).toEqual([{ kind: 'todo', refId: UUID }]);
    // …but as the plain cue grammar, so the brackets survive as literal text.
    expect(textOf(parseRefChips(`[todo: ${UUID}]`))).toBe(`[todo: [todo:${UUID}]]`);
  });
});

describe('parseRefChips — segment shape', () => {
  it('returns a single text segment when nothing matches', () => {
    expect(parseRefChips('nothing here')).toEqual([{ type: 'text', value: 'nothing here' }]);
  });

  it('returns nothing for an empty string', () => {
    expect(parseRefChips('')).toEqual([]);
  });
});

describe('remarkRefChips', () => {
  interface TestNode {
    type: string;
    value?: string;
    children?: TestNode[];
    data?: unknown;
  }

  function tree(children: TestNode[]): TestNode {
    return { type: 'root', children };
  }

  it('rewrites text nodes into ref-chip elements', () => {
    const root = tree([{ type: 'paragraph', children: [{ type: 'text', value: 'br_1234567890123456' }] }]);
    remarkRefChips()(root as never);
    const para = root.children?.[0];
    expect(para?.children?.[0]?.type).toBe('refChip');
    expect(para?.children?.[0]?.data).toEqual({
      hName: 'ref-chip',
      hProperties: { kind: 'session', refId: 'br_1234567890123456' },
    });
  });

  it('leaves text inside a link alone, so a pasted URL keeps its address', () => {
    const root = tree([
      { type: 'link', children: [{ type: 'text', value: 'br_1234567890123456' }] },
    ]);
    remarkRefChips()(root as never);
    expect(root.children?.[0]?.children?.[0]).toEqual({
      type: 'text',
      value: 'br_1234567890123456',
    });
  });

  it('resolves an id inside a single-backtick span', () => {
    // Backticks are how people set an id apart in prose, so these resolve. This
    // was reported as "session ids just show as text": every example had been
    // written in backticks, and none of them chipped.
    const root = tree([
      {
        type: 'paragraph',
        children: [{ type: 'inlineCode', value: 'br_1234567890123456' }],
      },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual(['refChip']);
    expect(kids[0]?.data).toEqual({
      hName: 'ref-chip',
      hProperties: { kind: 'session', refId: 'br_1234567890123456' },
    });
  });

  it('keeps the non-reference part of a code span as code', () => {
    const root = tree([
      { type: 'paragraph', children: [{ type: 'inlineCode', value: `todo: ${UUID}` }] },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual(['inlineCode', 'refChip']);
    expect(kids[0]?.value).toBe('todo: ');
  });

  it('leaves a code span with no reference completely alone', () => {
    const root = tree([
      { type: 'paragraph', children: [{ type: 'inlineCode', value: 'npm run build' }] },
    ]);
    remarkRefChips()(root as never);
    expect(root.children?.[0]?.children?.[0]).toEqual({
      type: 'inlineCode',
      value: 'npm run build',
    });
  });

  it('leaves a FENCED block alone, unlike an inline span', () => {
    // The two are the same shape and differ only by `type`. A fenced block holds
    // a payload — a curl command, a JSON body — and chipping inside one would
    // corrupt whatever a reader copies out of it.
    const root = tree([
      { type: 'code', value: `curl .../sessions/br_1234567890123456` },
    ]);
    remarkRefChips()(root as never);
    expect(root.children?.[0]).toEqual({
      type: 'code',
      value: 'curl .../sessions/br_1234567890123456',
    });
  });

  it('does not rescan the nodes it inserted', () => {
    const root = tree([
      { type: 'paragraph', children: [{ type: 'text', value: `todo: ${UUID}` }] },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    // text('todo: ') + one chip — never a chip nested inside a chip.
    expect(kids.map((k) => k.type)).toEqual(['text', 'refChip']);
  });

  it('rewrites a bracket token into a single chip with no literal siblings', () => {
    const root = tree([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: '[session:br_1786996794975654882]' }],
      },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    // No text('[session:') before it and no text(']') after it.
    expect(kids.map((k) => k.type)).toEqual(['refChip']);
    expect(kids[0]?.data).toEqual({
      hName: 'ref-chip',
      hProperties: { kind: 'session', refId: 'br_1786996794975654882' },
    });
  });

  it('resolves a bracket token inside a single-backtick span', () => {
    // Consistent with the existing cue behavior: a code span is prose emphasis.
    const root = tree([
      { type: 'paragraph', children: [{ type: 'inlineCode', value: `[task:${UUID}]` }] },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual(['refChip']);
    expect(kids[0]?.data).toEqual({
      hName: 'ref-chip',
      hProperties: { kind: 'todo', refId: UUID },
    });
  });

  it('leaves a bracket token inside a link alone', () => {
    const original: TestNode = { type: 'text', value: `[todo:${UUID}]` };
    const root = tree([{ type: 'link', children: [original] }]);
    remarkRefChips()(root as never);
    expect(root.children?.[0]?.children?.[0]).toBe(original);
  });

  // --- The decline paths: every place the walk refuses to rewrite. -----------
  //
  // A chip node carries its id as a `text` CHILD, so a chip is itself a parent
  // and re-scanning one descends straight back into the id it was built from.
  // Whether that produces a nested chip depends on which id: a bare uuid needs a
  // cue word in front of it and so cannot re-chip, while a session id is
  // unambiguous and chips wherever it appears. Every re-scan test below uses a
  // session id for that reason — the test above uses a uuid, which is why it
  // passes with the skip-past guard deleted.

  it('skips a hole in a children array rather than reading `type` off it', () => {
    const children: TestNode[] = [];
    children[1] = { type: 'text', value: 'br_1234567890123456' };
    const root = tree([{ type: 'paragraph', children }]);
    expect(() => remarkRefChips()(root as never)).not.toThrow();
    expect(root.children?.[0]?.children?.[1]?.type).toBe('refChip');
  });

  it('leaves a text node holding no reference as the SAME node, not a copy', () => {
    // `toEqual` cannot see this: the rebuilt node has the same `type` and
    // `value` and differs only by identity. Everything else a real mdast text
    // node carries — `position` above all — is dropped by the rebuild, so the
    // node that survives has to be the original object.
    const original: TestNode = { type: 'text', value: 'no references in here' };
    const root = tree([{ type: 'paragraph', children: [original] }]);
    remarkRefChips()(root as never);
    expect(root.children?.[0]?.children?.[0]).toBe(original);
  });

  it('leaves an EMPTY text node standing rather than splicing it away', () => {
    // The other half of the same guard, and it needs its own fixture: an empty
    // string parses to zero segments, so `.some(isChip)` is false for a reason
    // the test above cannot distinguish — there, segments exist and none is a
    // chip. A guard that only declined non-empty text would delete this node.
    const original: TestNode = { type: 'text', value: '' };
    const root = tree([{ type: 'paragraph', children: [original] }]);
    remarkRefChips()(root as never);
    expect(root.children?.[0]?.children).toHaveLength(1);
    expect(root.children?.[0]?.children?.[0]).toBe(original);
  });

  it('leaves a code span holding no reference as the SAME node, not a copy', () => {
    const original: TestNode = { type: 'inlineCode', value: 'npm run build' };
    const root = tree([{ type: 'paragraph', children: [original] }]);
    remarkRefChips()(root as never);
    expect(root.children?.[0]?.children?.[0]).toBe(original);
  });

  it('turns a whitespace-only leftover into text, not an empty code span', () => {
    // A span that is nothing but padding around an id leaves ' ' on either side.
    // Re-emitting those as `inlineCode` renders a pair of empty tick-mark boxes
    // flanking the chip. Distinct from the leftover rule the test above pins:
    // there the leftover has content and MUST stay code.
    const root = tree([
      { type: 'paragraph', children: [{ type: 'inlineCode', value: ' br_1234567890123456 ' }] },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual(['text', 'refChip', 'text']);
    expect(kids[0]?.value).toBe(' ');
    expect(kids[2]?.value).toBe(' ');
  });

  it('does not rescan a chip it inserted into a TEXT node', () => {
    const root = tree([
      { type: 'paragraph', children: [{ type: 'text', value: 'see br_1234567890123456 here' }] },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual(['text', 'refChip', 'text']);
    // The chip's own child is the id as plain text. Re-scanning the chip would
    // chip that id a second time and nest a chip inside a chip.
    expect(kids[1]?.children).toEqual([{ type: 'text', value: 'br_1234567890123456' }]);
  });

  it('does not rescan a chip it inserted into a CODE span', () => {
    // The inlineCode branch carries its own copy of the skip-past guard, so the
    // text-node test above says nothing about it.
    const root = tree([
      {
        type: 'paragraph',
        children: [{ type: 'inlineCode', value: 'see br_1234567890123456 here' }],
      },
    ]);
    remarkRefChips()(root as never);
    const kids = root.children?.[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual(['inlineCode', 'refChip', 'inlineCode']);
    expect(kids[1]?.children).toEqual([{ type: 'text', value: 'br_1234567890123456' }]);
  });
});
