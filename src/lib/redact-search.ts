/*
 * Redact keyword-search proposal layer (v0.10.0 rider, plan 261102-1005
 * phase 6). PURE — no React, no pdf.js: the tab feeds it visual text items
 * (getVisualTextItems — visual space WITH strings; the F5 engine truth is
 * that getTextItemRects carries NO strings and a different skip filter, so
 * rect/item zip is forbidden — grouping happens on the string-carrying
 * items and each run's rect derives from ITS OWN items).
 *
 * This layer PROPOSES marks only. Promotion appends to the same marks
 * array the draw path uses; apply stays exclusively runRedactionPipeline
 * (the "no second APPLY path" claim is structural — call count unchanged).
 */

import type { RedactMark } from './redact-pipeline';
import type { VisualTextItem } from '../engine/pdfjs';

type Item = VisualTextItem;

/** Word-space threshold as a fraction of font size (a Helvetica space is
 * ~0.28em; 0.2em catches word gaps without splitting tight kerning). */
const WORD_SPACE_FACTOR = 0.2;

/** A contiguous run of items on one baseline (the groupRuns band rule:
 * ±35% of the tallest item), split when the horizontal gap exceeds 2.5×
 * the band height — coarse enough to hold pdf.js fragments ("Joh"+"n"),
 * fine enough to never span a column gap. */
export interface ItemRun {
  items: Item[];
  baseline: number;
  /** Rendered text of the run: items in x order, space where the gap needs one. */
  text: string;
  /** Char offset of each item's first char inside `text` (alignment map). */
  offsets: number[];
}

export function runsFromItems(items: Item[]): ItemRun[] {
  // Rotated runs advance on a non-horizontal axis; banding them as
  // horizontal boxes produces proposals that do not correspond to their
  // glyphs (usually census-burned pages, but never propose what we cannot
  // draw honestly).
  const sorted = items.filter((i) => !i.rotated).sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const bands: Item[][] = [];
  for (const it of sorted) {
    const tol = Math.max(2, it.size * 0.35);
    const band = bands.find((b) => Math.abs(midBaseline(b) - it.baseline) <= tol);
    if (band) band.push(it);
    else bands.push([it]);
  }
  const runs: ItemRun[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.x0 - b.x0);
    // Split the band at column-scale gaps (>2.5× size joins nothing —
    // groupRuns rule); WORD-scale gaps (wordSpaceFactor) join WITH a space
    // so keywords can match across items on TJ-spaced PDFs ("John"+"Smith"
    // must never become "JohnSmith"). Two thresholds, two behaviors.
    let cur: Item[] = [];
    const flush = (): void => {
      if (cur.length === 0) return;
      let text = '';
      const offsets: number[] = [];
      let prev: Item | null = null;
      for (const it of cur) {
        const gap = prev ? it.x0 - prev.x1 : 0;
        if (
          prev &&
          gap > WORD_SPACE_FACTOR * Math.max(prev.size, it.size) &&
          !/\s$/.test(text) &&
          !/^\s/.test(it.str)
        ) {
          text += ' ';
        }
        offsets.push(text.length);
        text += it.str;
        prev = it;
      }
      runs.push({ items: cur, baseline: midBaseline(cur), text, offsets });
      cur = [];
    };
    for (const it of band) {
      const prev = cur[cur.length - 1];
      if (prev && it.x0 - prev.x1 > 2.5 * Math.max(prev.size, it.size)) flush();
      cur.push(it);
    }
    flush();
  }
  return runs;
}

function midBaseline(items: Item[]): number {
  return items.reduce((s, i) => s + i.baseline, 0) / items.length;
}

/** Case-insensitive, diacritics-EXACT substring matching: fold case only
 * (VN text matches byte-honestly through the NFKC the extractor already
 * applied — no accent stripping). The needle is NFKC-normalized too, so a
 * decomposed-form keyword (combining marks from some clipboard sources)
 * matches the composed haystack. Returns [charStart, charEnd) per hit,
 * leftmost-first, non-overlapping (a repeated keyword proposes every
 * occurrence, but one occurrence never matches twice). */
export function findMatches(runText: string, keyword: string): [number, number][] {
  const out: [number, number][] = [];
  const hay = runText.toLowerCase();
  const needle = keyword.normalize('NFKC').toLowerCase();
  if (needle.length === 0) return out;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    out.push([at, at + needle.length]);
    from = at + needle.length;
  }
  return out;
}

/**
 * One keyword hit → a proposed RedactMark covering the WHOLE RUN band
 * (first item's left edge → last item's right edge). Run-granular is
 * deliberate: the surgical tier removes a BT..ET block only when every
 * show op it touches lies FULLY inside a mark — a word-level mark would
 * refuse the page (the engine's partial-cover rule), and the review step
 * exists precisely so the user can drop a line they want to keep.
 * Fractions of the visible page box (top-left origin — the editor mark
 * model).
 *
 * The band MIRRORS THE WALKER'S OWN BOX MODEL (engine/pdf-lib.ts
 * redactSurgicalRemove): an op is modeled as baseline−0.85×size up to
 * baseline+0.25×size, width ≈0.55em/glyph, with a 6pt containment
 * tolerance. A box that hugs true advances and ends at the baseline
 * under-covers large/narrow-glyph text and the apply REFUSES; here the y
 * band is padded to 0.9×..1.15× and both x edges grow by 0.2×size (run
 * gaps are ≥2.5em, so the padding cannot reach a neighbor's ops).
 */
export function markForRun(
  run: ItemRun,
  page: number,
  pageW: number,
  pageH: number,
  id: string,
): RedactMark | null {
  if (pageW <= 0 || pageH <= 0) return null;
  const x0 = Math.min(...run.items.map((i) => i.x0));
  const x1 = Math.max(...run.items.map((i) => i.x1));
  const size = Math.max(...run.items.map((i) => i.size));
  if (!Number.isFinite(x0) || x1 <= x0 || size <= 0) return null;
  const pad = 0.2 * size;
  return {
    id,
    page,
    nx: Math.max(0, (x0 - pad) / pageW),
    nyTop: Math.max(0, (run.baseline - 0.9 * size) / pageH),
    nw: Math.min(1, (x1 + pad - x0) / pageW),
    nh: Math.min(1, (1.15 * size) / pageH),
  };
}

/** Every hit on every run of one page, in reading order; one proposal per
 * matching run (a line with two hits is ONE band — surgical-safe). */
export function proposeMarksForPage(
  items: Item[],
  keyword: string,
  page: number,
  pageW: number,
  pageH: number,
  newId: () => string,
): RedactMark[] {
  const marks: RedactMark[] = [];
  for (const run of runsFromItems(items)) {
    if (findMatches(run.text, keyword).length === 0) continue;
    const mark = markForRun(run, page, pageW, pageH, newId());
    if (mark) marks.push(mark);
  }
  return marks;
}

/** Promotion dedupe (rider risk L×M): a proposal already covered by an
 * existing mark (rect-equal or contained within +2% tolerance) is skipped. */
export function isCoveredBy(existing: RedactMark, proposal: RedactMark, tol = 0.02): boolean {
  return (
    existing.page === proposal.page &&
    proposal.nx >= existing.nx - tol &&
    proposal.nyTop >= existing.nyTop - tol &&
    proposal.nx + proposal.nw <= existing.nx + existing.nw + tol &&
    proposal.nyTop + proposal.nh <= existing.nyTop + existing.nh + tol
  );
}

export function dedupeProposals(proposals: RedactMark[], existing: RedactMark[]): RedactMark[] {
  const all = [...existing];
  const kept: RedactMark[] = [];
  for (const p of proposals) {
    if (all.some((m) => isCoveredBy(m, p))) continue;
    all.push(p);
    kept.push(p);
  }
  return kept;
}
