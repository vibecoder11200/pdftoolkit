import { describe, expect, it } from 'vitest';
import {
  COMPARE_DIFF_BUDGET,
  COMPARE_PAGE_CAP,
  COMPARE_WORDS_PER_PAGE,
  CompareCapError,
  LcsBudgetError,
  compareDocuments,
  comparePagePair,
  lcsTokens,
  wordsFromPage,
  type ComparePageInput,
  type DiffOp,
  type PagePair,
} from '../src/lib/pdf-compare';
import type { VisualTextItem } from '../src/engine/pdfjs';

/*
 * Compare engine specs (v0.11.0 phase 6) — pure, synthetic item arrays
 * (the lib is node-testable by contract; extraction is caller-wired and
 * never runs here). The acceptance pins: reflowed paragraph ⇒ 0 changes;
 * $2,200→$2,400 ⇒ exactly 2 tokens; the adversarial equal-length disjoint
 * pair hits the D-budget → wholesale verdict, never a freeze (red-team
 * S1's regression pin).
 */

const item = (str: string, x0: number, baseline: number, size = 10, over: Partial<VisualTextItem> = {}): VisualTextItem => ({
  str,
  x0,
  x1: x0 + str.length * size * 0.5,
  baseline,
  size,
  fontName: 'F',
  rotated: false,
  ...over,
});

const page = (lines: string[], width = 595, height = 842): ComparePageInput => ({
  items: lines.map((l, i) => item(l, 48, 100 + i * 16)),
  width,
  height,
});

const wordsOf = (pair: PagePair): string[] => pair.inserted.map((w) => w.text);
const removedOf = (pair: PagePair): string[] => pair.removed.map((w) => w.text);

// ---------------------------------------------------------------------------
// lcsTokens (the exported token LCS — P8's textDiff wraps it).
// ---------------------------------------------------------------------------

describe('lcsTokens (Myers, linear-space)', () => {
  const kinds = (ops: DiffOp[]) => ops.map((o) => o.kind).join(',');

  it('identical sequences emit one equal run', () => {
    const ops = lcsTokens(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(kinds(ops)).toBe('equal');
    expect(ops[0]).toMatchObject({ aStart: 0, aEnd: 3, bStart: 0, bEnd: 3 });
  });

  it('single token change in a sentence is one delete + one insert between equal runs', () => {
    const a = ['Total', 'due', '$2,200', 'net', '30'];
    const b = ['Total', 'due', '$2,400', 'net', '30'];
    const ops = lcsTokens(a, b);
    expect(kinds(ops)).toBe('equal,delete,insert,equal');
    expect(ops[1]).toMatchObject({ aStart: 2, aEnd: 3 });
    expect(ops[2]).toMatchObject({ bStart: 2, bEnd: 3 });
  });

  it('moved token: the token is one delete+insert around the move-invariant equal run', () => {
    const ops = lcsTokens(['x', 't1', 't2', 't3'], ['t1', 't2', 't3', 'x']);
    expect(kinds(ops)).toBe('delete,equal,insert');
    expect(ops[0]).toMatchObject({ aStart: 0, aEnd: 1 }); // 'x' removed from front
    expect(ops[1]).toMatchObject({ aStart: 1, aEnd: 4, bStart: 0, bEnd: 3 }); // t1,t2,t3 shared
    expect(ops[2]).toMatchObject({ bStart: 3, bEnd: 4 }); // 'x' inserted at back
  });

  it('completely disjoint sequences: delete-all then insert-all', () => {
    const ops = lcsTokens(['a', 'b'], ['c', 'd']);
    expect(kinds(ops)).toBe('delete,insert');
    expect(ops[0]).toMatchObject({ aStart: 0, aEnd: 2 });
    expect(ops[1]).toMatchObject({ bStart: 0, bEnd: 2 });
  });

  it('empty sides emit pure insert or pure delete', () => {
    expect(lcsTokens([], ['a', 'b'])).toEqual([{ kind: 'insert', aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }]);
    expect(lcsTokens(['a'], [])).toEqual([{ kind: 'delete', aStart: 0, aEnd: 1, bStart: 0, bEnd: 0 }]);
    expect(lcsTokens([], [])).toEqual([]);
  });

  it('ops tile the index space contiguously (a valid edit script)', () => {
    const a = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'dog'];
    const b = ['the', 'quick', 'red', 'fox', 'leaps', 'over', 'the', 'lazy', 'dog'];
    const ops = lcsTokens(a, b);
    let ai = 0;
    let bi = 0;
    for (const op of ops) {
      expect(op.aStart).toBe(ai);
      expect(op.bStart).toBe(bi);
      if (op.kind !== 'insert') ai = op.aEnd;
      if (op.kind !== 'delete') bi = op.bEnd;
    }
    expect(ai).toBe(a.length);
    expect(bi).toBe(b.length);
  });

  it('budget exhaustion raises LcsBudgetError (typed, inside the loop)', () => {
    // Long disjoint sequences: the middle-snake loop burns the budget.
    const a = Array.from({ length: 20000 }, (_, i) => `w${i}`);
    const b = Array.from({ length: 20000 }, (_, i) => `v${i}`);
    expect(() => lcsTokens(a, b)).toThrow(LcsBudgetError);
    // Sanity: the budget constant is what the loop enforces.
    expect(COMPARE_DIFF_BUDGET).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Word splitting.
// ---------------------------------------------------------------------------

describe('wordsFromPage (via comparePagePair marks)', () => {
  it('VN diacritics compare byte-exact (case-sensitive, extractor NFKC)', () => {
    const oldP = page(['Lợi nhuận trước thuế đạt 428 tỷ']);
    const newP = page(['Lợi nhuận trước thuế đạt 512 tỷ']);
    const pair = comparePagePair(1, 1, wordsFromPage(oldP), wordsFromPage(newP));
    expect(removedOf(pair)).toEqual(['428']);
    expect(wordsOf(pair)).toEqual(['512']);
  });

  it('case-sensitive: VietNam vs vietnam is a change', () => {
    const pair = comparePagePair(1, 1, wordsFromPage(page(['VietNam Bank'])), wordsFromPage(page(['vietnam Bank'])));
    expect(removedOf(pair)).toEqual(['VietNam']);
    expect(wordsOf(pair)).toEqual(['vietnam']);
  });

  it('rotated items are skipped entirely (nothing draws at rotated positions)', () => {
    const oldP: ComparePageInput = {
      items: [item('Straight line', 48, 100), item('Rotated stamp', 48, 200, 10, { rotated: true })],
      width: 595,
      height: 842,
    };
    const newP: ComparePageInput = { items: [item('Straight line', 48, 100)], width: 595, height: 842 };
    const pair = comparePagePair(1, 1, wordsFromPage(oldP), wordsFromPage(newP));
    expect(pair.removed).toHaveLength(0);
    expect(pair.inserted).toHaveLength(0);
  });

  it('column-scale gaps never join; word-scale gaps split tokens', () => {
    // One visual row: "Amount Paid" | "2.500" — the 100pt gap is a column
    // boundary; tokens stay separate words.
    const oldP: ComparePageInput = {
      items: [item('Amount', 48, 100), item('Paid', 80, 100), item('2.500', 300, 100)],
      width: 400,
      height: 200,
    };
    const newP: ComparePageInput = {
      items: [item('Amount', 48, 100), item('Paid', 80, 100), item('3.000', 300, 100)],
      width: 400,
      height: 200,
    };
    const pair = comparePagePair(1, 1, wordsFromPage(oldP), wordsFromPage(newP));
    expect(removedOf(pair)).toEqual(['2.500']);
    expect(wordsOf(pair)).toEqual(['3.000']);
  });

  it('multi-word item strings split into words with proportional boxes', () => {
    const oldP = page(['The quick brown fox']);
    const newP = page(['The quick red fox']);
    const pair = comparePagePair(1, 1, wordsFromPage(oldP), wordsFromPage(newP));
    expect(removedOf(pair)).toEqual(['brown']);
    expect(wordsOf(pair)).toEqual(['red']);
    // The box is inside the page and ordered by advance.
    const w = pair.inserted[0]!;
    expect(w.nx).toBeGreaterThanOrEqual(0);
    expect(w.nx + w.nw).toBeLessThanOrEqual(1);
    expect(w.ny).toBeGreaterThanOrEqual(0);
  });

  it('fractions use the markForRun box model bounds (y band 0.9..1.15 x size)', () => {
    const oldP: ComparePageInput = { items: [item('Word', 100, 500, 10)], width: 1000, height: 1000 };
    const pair = comparePagePair(1, 1, wordsFromPage(oldP), wordsFromPage({ items: [], width: 1000, height: 1000 }));
    const w = pair.removed[0]!;
    expect(w.ny).toBeCloseTo((500 - 9) / 1000, 5);
    expect(w.nh).toBeCloseTo(11.5 / 1000, 5);
    expect(w.nx).toBeCloseTo((100 - 2) / 1000, 5);
  });

  it('degenerate page boxes yield zero fractions (op boundary fail-closes later)', () => {
    const oldP: ComparePageInput = { items: [item('Word', 100, 500, 10)], width: 0, height: -5 };
    const pair = comparePagePair(1, 1, wordsFromPage(oldP), wordsFromPage({ items: [], width: 0, height: -5 }));
    const w = pair.removed[0]!;
    expect(w.nx).toBe(0);
    expect(w.ny).toBe(0);
    expect(w.nw).toBe(0);
    expect(w.nh).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Page alignment + document assembly.
// ---------------------------------------------------------------------------

describe('compareDocuments (page alignment)', () => {
  it('aligned pair with a word change: one changed pair, exactly 2 tokens', () => {
    const res = compareDocuments([page(['Invoice total: $2,200 due'])], [page(['Invoice total: $2,400 due'])]);
    expect(res.unaligned).toBe(false);
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]).toMatchObject({ oldPage: 1, newPage: 1 });
    expect(res.pairs[0]!.inserted).toEqual([expect.objectContaining({ text: '$2,400' })]);
    expect(res.pairs[0]!.removed).toEqual([expect.objectContaining({ text: '$2,200' })]);
    expect(res.stats).toEqual({ pagesChanged: 1, wordsAdded: 1, wordsRemoved: 1, suppressed: 0 });
  });

  it('inserted page lands in addedPages with a banner pair; removed page in removedPages', () => {
    const res = compareDocuments(
      [page(['page one']), page(['page two'])],
      [page(['page one']), page(['page two']), page(['page three'])],
    );
    expect(res.unaligned).toBe(false);
    expect(res.addedPages).toEqual([3]);
    expect(res.removedPages).toEqual([]);
    expect(res.pairs).toHaveLength(3);
    expect(res.pairs[2]).toMatchObject({ oldPage: 0, newPage: 3, inserted: [], removed: [] });
  });

  it('removed page: oldPage set, newPage null, no marks', () => {
    const res = compareDocuments(
      [page(['alpha']), page(['beta']), page(['gamma'])],
      [page(['alpha']), page(['gamma'])],
    );
    expect(res.removedPages).toEqual([2]);
    expect(res.addedPages).toEqual([]);
    expect(res.pairs[1]).toMatchObject({ oldPage: 2, newPage: null });
  });

  it('reordered pages: the shared digest aligns, the moved pages banner (ordered LCS)', () => {
    const res = compareDocuments([page(['first page']), page(['second page'])], [page(['second page']), page(['first page'])]);
    expect(res.unaligned).toBe(false);
    expect(res.removedPages).toEqual([1]);
    expect(res.addedPages).toEqual([2]);
    expect(res.pairs).toHaveLength(3);
    // The shared 'second page' pair carries no word changes.
    expect(res.pairs[1]).toMatchObject({ oldPage: 2, newPage: 1, inserted: [], removed: [] });
    expect(res.stats.pagesChanged).toBe(0);
  });

  it('ALL-different digests → unaligned: true + index pairing (never all-added)', () => {
    const res = compareDocuments(
      [page(['totally different']), page(['also different here'])],
      [page(['nothing matches']), page(['none at all'])],
    );
    expect(res.unaligned).toBe(true);
    expect(res.addedPages).toEqual([]);
    expect(res.removedPages).toEqual([]);
    expect(res.pairs).toHaveLength(2);
    expect(res.pairs[0]).toMatchObject({ oldPage: 1, newPage: 1 });
    expect(res.pairs[1]).toMatchObject({ oldPage: 2, newPage: 2 });
  });

  it('whitespace-only differences: a re-wrapped paragraph ⇒ 0 changes (acceptance pin)', () => {
    const oldP = page(['aaaa bbbb', 'cccc dddd']);
    const newP = page(['aaaa', 'bbbb cccc', 'dddd']);
    const res = compareDocuments([oldP], [newP]);
    expect(res.stats.pagesChanged).toBe(0);
    // Word-level tokenization absorbs the re-wrap before hunks exist, so
    // the suppression counter stays 0 — the filter is the defense in
    // depth for hunk-shaped re-wraps (adjacent delete+insert ties).
    expect(res.stats.suppressed).toBe(0);
    expect(res.pairs[0]!.inserted).toHaveLength(0);
    expect(res.pairs[0]!.removed).toHaveLength(0);
  });

  it('a real change inside a re-wrap shows exactly the changed tokens', () => {
    const oldP = page(['aaaa bbbb', 'cccc dddd']);
    const newP = page(['aaaa', 'bbbb cxxxx', 'dddd']);
    const res = compareDocuments([oldP], [newP]);
    expect(removedOf(res.pairs[0]!)).toEqual(['cccc']);
    expect(wordsOf(res.pairs[0]!)).toEqual(['cxxxx']);
  });

  it('GAP-REGION PAIRING (phase-7 repair): a word change on p1 + added p3 stays aligned', () => {
    // The exact-text digest unaligns the edited page; the gap region pairs
    // it back (similarity ≥ 0.5) so the word diff shows its 2 tokens
    // instead of a silent removed+added banner with no marks.
    const res = compareDocuments(
      [page(['Invoice total: $2,200 due']), page(['shared page two'])],
      [page(['Invoice total: $2,400 due']), page(['shared page two']), page(['brand new page three'])],
    );
    expect(res.unaligned).toBe(false);
    expect(res.addedPages).toEqual([3]);
    expect(res.removedPages).toEqual([]);
    expect(res.pairs[0]).toMatchObject({ oldPage: 1, newPage: 1 });
    expect(res.pairs[0]!.inserted).toEqual([expect.objectContaining({ text: '$2,400' })]);
    expect(res.pairs[0]!.removed).toEqual([expect.objectContaining({ text: '$2,200' })]);
    expect(res.pairs[1]).toMatchObject({ oldPage: 2, newPage: 2, inserted: [], removed: [] });
    expect(res.stats).toEqual({ pagesChanged: 1, wordsAdded: 1, wordsRemoved: 1, suppressed: 0 });
  });

  it('gap region refuses a REPLACED page (similarity below 0.5) — honest banners, no marks', () => {
    const res = compareDocuments(
      [page(['one shared anchor']), page(['completely different words here'])],
      [page(['one shared anchor']), page(['wholly unrelated replacement text']), page(['extra new page'])],
    );
    expect(res.unaligned).toBe(false);
    expect(res.removedPages).toEqual([2]);
    expect(res.addedPages).toEqual([2, 3]);
    expect(res.pairs[1]).toMatchObject({ oldPage: 2, newPage: null, inserted: [], removed: [] });
    expect(res.pairs[2]).toMatchObject({ oldPage: 0, newPage: 2 });
  });

  it('identical documents produce a fully clean report', () => {
    const doc = [page(['same line one']), page(['same line two'])];
    const res = compareDocuments(doc, doc.map((p) => ({ items: p.items.map((i) => ({ ...i })), width: p.width, height: p.height })));
    expect(res.stats).toEqual({ pagesChanged: 0, wordsAdded: 0, wordsRemoved: 0, suppressed: 0 });
    expect(res.unaligned).toBe(false);
    expect(res.pairs.every((p) => p.inserted.length === 0 && p.removed.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budgets.
// ---------------------------------------------------------------------------

describe('budgets (typed, never silent)', () => {
  it('page cap refuses above 100 pages on either doc', () => {
    const big = Array.from({ length: COMPARE_PAGE_CAP + 1 }, () => page(['x']));
    expect(() => compareDocuments(big, [page(['x'])])).toThrow(CompareCapError);
    expect(() => compareDocuments([page(['x'])], big)).toThrow(CompareCapError);
  });

  it('per-page word cap refuses instead of truncating', () => {
    const spam: ComparePageInput = {
      items: Array.from({ length: COMPARE_WORDS_PER_PAGE + 1 }, (_, i) => item(`w${i}`, i * 40, 100)),
      width: 595,
      height: 842,
    };
    expect(() => compareDocuments([spam], [page(['x'])])).toThrow(CompareCapError);
  });

  it('adversarial equal-length disjoint pair hits the D-budget → wholesale verdict (S1 pin)', () => {
    // 20k distinct words on both sides — the middle-snake loop exhausts
    // COMPARE_DIFF_BUDGET and the pair degrades; the tab never freezes.
    const mk = (prefix: string): ComparePageInput => ({
      items: Array.from({ length: 20000 }, (_, i) => item(`${prefix}${i}`, (i % 40) * 14, 100 + Math.floor(i / 40) * 12)),
      width: 600,
      height: 842,
    });
    const res = compareDocuments([mk('a')], [mk('b')]);
    expect(res.pairs[0]!.wholesale).toBeDefined();
    expect(res.pairs[0]!.wholesale!.oldText).toContain('a0');
    expect(res.pairs[0]!.wholesale!.newText).toContain('b0');
    expect(res.pairs[0]!.inserted).toHaveLength(0);
    expect(res.pairs[0]!.removed).toHaveLength(0);
    expect(res.stats.pagesChanged).toBe(1);
  }, 120_000);

  it('coordinate garbage is dropped at the boundary (F1 sanity rule)', () => {
    const bad: ComparePageInput = {
      items: [
        item('good', 48, 100),
        item('nan', NaN, 100),
        item('inf', Infinity, 100),
        item('huge', 5e6, 100),
        { ...item('zero', 48, 100), size: 0 },
      ],
      width: 595,
      height: 842,
    };
    const res = compareDocuments([bad], [page(['good'])]);
    expect(res.pairs[0]!.removed).toHaveLength(0);
    expect(res.stats.wordsRemoved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('two runs over the same inputs deep-equal', () => {
    const oldPages = [page(['alpha beta gamma', 'total: $2,200']), page(['page two text'])];
    const newPages = [page(['alpha beta delta', 'total: $2,400'])];
    const r1 = compareDocuments(oldPages, newPages);
    const r2 = compareDocuments(oldPages, newPages);
    expect(r2).toEqual(r1);
  });
});
