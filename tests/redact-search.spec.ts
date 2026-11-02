import { describe, expect, it } from 'vitest';
import {
  dedupeProposals,
  findMatches,
  isCoveredBy,
  markForRun,
  proposeMarksForPage,
  runsFromItems,
} from '../src/lib/redact-search';
import type { VisualTextItem } from '../src/engine/pdfjs';
import type { RedactMark } from '../src/lib/redact-pipeline';

/*
 * Redact keyword-search proposal layer (v0.10.0 rider phase 6): pure
 * functions over synthetic visual items — fragment joining (the "Joh"+"n"
 * pdf.js split), column-gap run splitting, case-fold/diacritics-exact
 * matching, char-proportional rect derivation, promotion dedupe. The F11
 * fresh-geometry guard: proposals derive ONLY from the passed items (no
 * module-level memoization can ever survive a file swap).
 */

const item = (str: string, x0: number, baseline = 12, size = 12, widthFactor = 0.5): VisualTextItem => ({
  str,
  x0,
  x1: x0 + str.length * widthFactor * size,
  baseline,
  size,
  fontName: 'F1',
  rotated: false,
});

describe('runsFromItems (F5: grouping on string-carrying items)', () => {
  it('joins same-baseline fragments into one run with an alignment map', () => {
    // 'Joh' ends at 48+18=66; 1pt kerning-scale gap → no space inserted.
    const runs = runsFromItems([item('Joh', 48), item('n Doe', 67, 12)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe('John Doe');
    expect(runs[0]!.offsets).toEqual([0, 3]);
  });

  it('splits at column-scale gaps (2.5× size rule)', () => {
    // 12pt font: 2.5× = 30pt gap threshold — 90pt gap must split.
    const runs = runsFromItems([item('Left', 48), item('Right', 180, 12)]);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.text).sort()).toEqual(['Left', 'Right']);
  });

  it('separates distinct baselines', () => {
    const runs = runsFromItems([item('top', 48, 100), item('bottom', 48, 140)]);
    expect(runs).toHaveLength(2);
  });
});

describe('findMatches (case-insensitive, diacritics-exact)', () => {
  it('matches case-folded, every occurrence, non-overlapping', () => {
    // 'johnny' CONTAINS 'john' — honest substring semantics (matches how
    // keyword scrub treats secrets); occurrences never overlap themselves.
    expect(findMatches('John johnny JOHN', 'john')).toEqual([
      [0, 4],
      [5, 9],
      [12, 16],
    ]);
  });

  it('does NOT fold diacritics (Vietnamese byte honesty)', () => {
    expect(findMatches('Hoa don hoá đơn', 'hoa don')).toEqual([[0, 7]]);
    expect(findMatches('họa', 'hoa')).toEqual([]);
    expect(findMatches('đơn', 'don')).toEqual([]);
  });

  it('empty keyword matches nothing', () => {
    expect(findMatches('abc', '')).toEqual([]);
  });
});

describe('markForRun (run-band rect derivation, walker-box parity)', () => {
  const run = runsFromItems([item('ABCD EFGH', 100, 200, 10, 6)])[0]!;

  it('the proposal covers the FULL run band, padded to the walker box', () => {
    const mark = markForRun(run, 1, 600, 800, 'm1')!;
    // x: 100-2 → 640+2 (0.2×size pad both edges); y: baseline-0.9×size
    // down 1.15×size — mirrors the surgical walker's box model.
    expect(mark.page).toBe(1);
    expect(mark.nx).toBeCloseTo(98 / 600, 5);
    expect(mark.nw).toBeCloseTo(542 / 600, 5);
    expect(mark.nyTop).toBeCloseTo(191 / 800, 5);
    expect(mark.nh).toBeCloseTo(11.5 / 800, 5);
  });

  it('WALKER-BOX CONTAINMENT across font sizes: the mark always covers the op box the engine models', () => {
    // The surgical tier models an op as baseline−0.85×size .. baseline+0.25×size
    // with a 6pt containment tolerance (REDACT_CONTAIN_TOL). A proposal that
    // under-covers either bound makes apply REFUSE the page (>24pt text
    // shipped exactly that bug class) — pin both bounds across sizes.
    for (const size of [8, 11, 14, 24, 48, 96]) {
      const r = runsFromItems([item('SECRET', 100, 400, size, 6)])[0]!;
      const m = markForRun(r, 1, 600, 1200, 'w')!;
      const top = m.nyTop * 1200;
      const bottom = (m.nyTop + m.nh) * 1200;
      expect(top).toBeLessThanOrEqual(400 - 0.85 * size + 6);
      expect(bottom).toBeGreaterThanOrEqual(400 + 0.25 * size - 6);
    }
  });

  it('degenerate page size refuses', () => {
    expect(markForRun(run, 1, 0, 800, 'm2')).toBeNull();
  });
});

describe('runsFromItems word-gap joining (TJ-spaced PDFs)', () => {
  it('a WORD-scale gap joins items WITH a space (keyword can match across)', () => {
    // 12pt: word threshold 0.2×12=2.4, split threshold 2.5×12=30.
    // A 6pt gap is a word gap → one run, 'John Smith'.
    const runs = runsFromItems([item('John', 48), item('Smith', 78)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe('John Smith');
    expect(runs[0]!.offsets).toEqual([0, 5]);
    expect(findMatches(runs[0]!.text, 'John Smith')).toEqual([[0, 10]]);
  });

  it('a tight kerning gap joins WITHOUT a space', () => {
    // item 'Joh' ends at 48+18=66; 'n' at 67 → 1pt gap < 2.4 (the word
    // threshold) → no space: 'Joh'+'n' stays 'John'.
    const runs = runsFromItems([item('Joh', 48), item('n', 67)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe('John');
  });
});

describe('findMatches NFKC needle folding', () => {
  it('a full-width needle matches its ASCII haystack form', () => {
    expect(findMatches('abc', 'ＡＢＣ')).toEqual([[0, 3]]);
  });
});

describe('proposeMarksForPage (end-to-end on a synthetic page)', () => {
  it('proposes one band per MATCHING RUN (a line with two hits is ONE mark)', () => {
    const items = [
      item('Contract with John and John again', 48, 100),
      item('Signed by Joh', 48, 140),
      item('n and Jane', 92, 140), // "Joh"+"n" split across items
      item('No keyword here', 48, 180),
    ];
    let seq = 0;
    const marks = proposeMarksForPage(items, 'john', 3, 600, 800, () => `m${++seq}`);
    expect(marks).toHaveLength(2); // one per line, not per occurrence
    expect(marks[0]!.page).toBe(3);
    expect(marks[0]!.nyTop).toBeLessThan(marks[1]!.nyTop); // top before bottom
  });

  it('F11 fresh geometry: the same keyword over DIFFERENT items derives only from them', () => {
    const fileA = [item('John here', 48, 100, 12)];
    const fileB = [item('padding', 48, 100, 12), item('John moved', 200, 320, 14)];
    let seq = 0;
    const a = proposeMarksForPage(fileA, 'john', 1, 600, 800, () => `m${++seq}`);
    const b = proposeMarksForPage(fileB, 'john', 1, 600, 800, () => `m${++seq}`);
    expect(a[0]!.nx).not.toBe(b[0]!.nx);
    expect(b[0]!.nyTop).not.toBe(a[0]!.nyTop);
  });
});

describe('promotion dedupe (overlap risk L×M)', () => {
  const mk = (id: string, page: number, nx: number, nyTop: number, nw: number, nh: number): RedactMark => ({
    id,
    page,
    nx,
    nyTop,
    nw,
    nh,
  });

  it('skips proposals equal/contained in existing marks, keeps the rest', () => {
    const existing = [mk('e1', 1, 0.1, 0.1, 0.2, 0.02)];
    const proposals = [
      mk('p1', 1, 0.1, 0.1, 0.2, 0.02), // equal → skip
      mk('p2', 1, 0.12, 0.11, 0.1, 0.01), // contained → skip
      mk('p3', 1, 0.5, 0.5, 0.1, 0.02), // elsewhere → keep
      mk('p4', 2, 0.1, 0.1, 0.2, 0.02), // other page → keep
    ];
    const kept = dedupeProposals(proposals, existing);
    expect(kept.map((m) => m.id)).toEqual(['p3', 'p4']);
    expect(isCoveredBy(existing[0]!, proposals[1]!)).toBe(true);
  });
});
