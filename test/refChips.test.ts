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
});
