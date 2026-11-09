/*
 * PDF compare engine (v0.11.0 phase 6, plan 261109-1101).
 *
 * ONE flat pure library turning two per-page text-item arrays into a
 * structured comparison: word tokens with positions → Myers O(ND) LCS
 * (two-pass greedy with snapshot backtrace, re-expressed from the published
 * algorithm — no jsdiff, no vendored code) → page alignment over text
 * digests → a reflow filter so a re-wrapped paragraph never reads as
 * changes → per-pair word marks in fractions of the visible page box (the
 * redact-search box model).
 *
 * Extraction is CALLER-WIRED (the pdf2word extractPage seam): the lib never
 * fetches and never touches bytes. Everything here is node-testable with
 * synthetic item arrays; the tool UI (P7) is the only consumer and goes
 * through runCompare (phase 7), never through pieces of this file.
 *
 * Pure lib: no React, no i18n, no worker imports, zero deps.
 */

import type { VisualTextItem } from '../engine/pdfjs';

// ---------------------------------------------------------------------------
// Budgets — typed refusals, never silent truncation (the pdf2word F1 rule).
// ---------------------------------------------------------------------------

export const COMPARE_PAGE_CAP = 100;
export const COMPARE_WORDS_PER_PAGE = 20_000;

/** Absolute op budget for one pair's diff (V-updates + snake steps inside
 * the greedy loop). On bail the pair degrades to a typed `wholesale`
 * verdict — the tab can never freeze inside one pair, however adversarial
 * the input (red-team S1: the original relative trigger was unreachable;
 * an absolute in-loop budget is the honest bound). */
export const COMPARE_DIFF_BUDGET = 2e7;

/** Coordinates beyond this are garbage; the item is dropped at the
 * boundary (pdf2word F1 sanity rule). */
const COMPARE_COORD_LIMIT = 1e6;

export class CompareCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareCapError';
  }
}

/** Raised by lcsTokens when the pair exhausts COMPARE_DIFF_BUDGET (or its
 * true D exceeds the backtrace snapshot bound) — the caller degrades the
 * pair to a wholesale verdict. */
export class LcsBudgetError extends Error {
  constructor() {
    super('pdf-compare: page pair exceeded the diff budget (wholesale degrade)');
    this.name = 'LcsBudgetError';
  }
}

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface ComparePageInput {
  items: VisualTextItem[];
  width: number;
  height: number;
}

/** One diff token: the word, its normalized compare form, its fractions of
 * the visible page box (top-left origin — the repo convention), and its
 * visual-space geometry (for P8's band coalescing). */
export interface CompWord {
  text: string;
  norm: string;
  /** Fractions (top-left origin). Zero when the page box is degenerate —
   * the P8 op boundary fail-closes on those, never draws them. */
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  /** Visual space (y-down) — coalescing + honest boxes. */
  x0: number;
  x1: number;
  baseline: number;
  size: number;
}

export type DiffOpKind = 'equal' | 'delete' | 'insert';

export interface DiffOp {
  kind: DiffOpKind;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface PagePair {
  /** 1-based page in doc A (the old document). */
  oldPage: number;
  /** 1-based page in doc B (the new document); null when the page only
   * exists in A (it carries no diff marks). */
  newPage: number | null;
  /** Words present only in B — drawn on the NEW page. */
  inserted: CompWord[];
  /** Words present only in A — drawn on the OLD page. */
  removed: CompWord[];
  /** D-budget bail: the pages differ wholesale; the UI shows the clause
   * view and draws no marks (honest degrade, never a freeze). */
  wholesale?: { oldText: string; newText: string };
  /** Scan pages only (P8's AI leg): text clauses, no positions. */
  textDiff?: { added: string[]; removed: string[] };
}

export interface CompareResult {
  pairs: PagePair[];
  /** 1-based B pages with no A counterpart (banners). */
  addedPages: number[];
  /** 1-based A pages with no B counterpart (banners). */
  removedPages: number[];
  /** No page digest matched anywhere — the UI says so and falls back to
   * index pairing instead of a silently useless all-added report. */
  unaligned: boolean;
  stats: { pagesChanged: number; wordsAdded: number; wordsRemoved: number; suppressed: number };
}

// ---------------------------------------------------------------------------
// Words: item arrays → positioned word tokens.
//
// The split reuses the redact-search gap rules by value (cited, not
// imported — a shared-constants refactor is out of scope for zero user
// value): a band is one visual row (±35% size tolerance); a gap > 2.5×
// size is a COLUMN boundary and never joins; a gap > 0.2× size is a word
// boundary (the token SPLITS there), while smaller gaps continue the same
// word (TJ-kerned item splits glue). Rotated items are SKIPPED (the flag
// exists precisely because nothing downstream can band them honestly —
// pdfjs.ts:209; honest UI copy covers it; pdf2word's accept-the-limitation
// posture does NOT apply here because compare DRAWS at these positions).
// ---------------------------------------------------------------------------

/** Multi-word item strings split on whitespace with proportional advance
 * mapping (pdf.js items carry one advance width for the whole chunk).
 * Exported: the tool's doc-token caches store the derived CompWords so a
 * swap/re-run costs zero re-extraction (phase 7). */
export function wordsFromPage(page: ComparePageInput): CompWord[] {
  const ok = (v: number) => Number.isFinite(v) && Math.abs(v) <= COMPARE_COORD_LIMIT;
  const sane = page.items.filter((i) => !i.rotated && ok(i.x0) && ok(i.x1) && ok(i.baseline) && i.size > 0);
  const byBaseline = [...sane].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const words: CompWord[] = [];
  const W = page.width > 0 && Number.isFinite(page.width) ? page.width : 0;
  const H = page.height > 0 && Number.isFinite(page.height) ? page.height : 0;

  let band: VisualTextItem[] = [];
  const flushBand = (): void => {
    if (band.length === 0) return;
    band.sort((a, b) => a.x0 - b.x0);
    let run: VisualTextItem[] = [];
    const flushRun = (): void => {
      if (run.length === 0) return;
      // Walk the run emitting words: item gaps > 0.2× size start a new
      // word; item strings split on whitespace with proportional advances.
      let cur: { text: string; x0: number; x1: number; baseline: number; size: number } | null = null;
      const emit = (): void => {
        if (!cur) return;
        const text = cur.text.replace(/\s+/g, ' ').trim();
        if (text.length === 0) {
          cur = null;
          return;
        }
        words.push(toCompWord(text, cur.x0, cur.x1, cur.baseline, cur.size, W, H));
        cur = null;
      };
      let prev: VisualTextItem | null = null;
      for (const it of run) {
        const gap = prev ? it.x0 - prev.x1 : 0;
        if (prev && gap > 0.2 * Math.max(prev.size, it.size)) emit();
        const parts = it.str.split(/\s+/).filter((p) => p.length > 0);
        const span = Math.max(0, it.x1 - it.x0);
        const per = it.str.length > 0 ? span / it.str.length : 0;
        let cursor = it.x0;
        for (const [pi, part] of parts.entries()) {
          if (pi > 0) emit(); // whitespace inside the item splits words
          const wx0 = cursor;
          const wx1 = cursor + per * part.length;
          if (cur) {
            cur.text += part;
            cur.x1 = Math.max(cur.x1, wx1);
          } else {
            cur = { text: part, x0: wx0, x1: wx1, baseline: it.baseline, size: it.size };
          }
          cursor = wx1 + per; // account for the dropped separator char
        }
        if (parts.length === 0) emit(); // whitespace-only item ends the word
        prev = it;
      }
      emit();
      run = [];
    };
    for (const it of band) {
      const prev = run[run.length - 1];
      if (prev && it.x0 - prev.x1 > 2.5 * Math.max(prev.size, it.size)) flushRun();
      run.push(it);
    }
    flushRun();
    band = [];
  };

  for (const it of byBaseline) {
    const prev = band[band.length - 1];
    const tol = Math.max(2, it.size * 0.35);
    if (prev && Math.abs(prev.baseline - it.baseline) > tol) flushBand();
    band.push(it);
  }
  flushBand();
  return words;
}

/** Fractions via the redact-search box model (baseline −0.9×size …
 * +1.15×size band; x pad 0.2×size — markForRun's do-not-double-flip twin,
 * top-left origin like every editor mark). */
function toCompWord(
  text: string,
  x0: number,
  x1: number,
  baseline: number,
  size: number,
  W: number,
  H: number,
): CompWord {
  const pad = 0.2 * size;
  return {
    text,
    norm: text, // NFKC already applied by the extractor; case-SENSITIVE (legal redline semantics)
    nx: W > 0 ? Math.max(0, (x0 - pad) / W) : 0,
    ny: H > 0 ? Math.max(0, (baseline - 0.9 * size) / H) : 0,
    nw: W > 0 ? Math.min(1, (x1 + pad - x0) / W) : 0,
    nh: H > 0 ? Math.min(1, (1.15 * size) / H) : 0,
    x0,
    x1,
    baseline,
    size,
  };
}

/** Page digest for alignment: whitespace-collapsed normalized text (words
 * are already normalized — the join IS the collapse). */
function pageDigest(words: CompWord[]): string {
  return words.map((w) => w.norm).join(' ');
}

// ---------------------------------------------------------------------------
// Myers LCS: two-pass greedy O(ND) with snapshot backtrace (re-expressed
// from Myers' published algorithm — "An O(ND) Difference Algorithm and Its
// Variations", 1986 — no vendored code). Pass 1 finds D with the classic
// furthest-reaching-x greedy and an ABSOLUTE in-loop budget (V-updates +
// snake steps); a bail raises LcsBudgetError and the pair degrades to the
// wholesale verdict — the tab can never freeze, however adversarial the
// input (red-team S1: the original relative trigger was mathematically
// unreachable). Pass 2 reruns the same deterministic greedy storing one V
// snapshot per D row (memory O(D²), bounded by MYERS_SNAPSHOT_D_CAP —
// pairs whose D exceeds the cap degrade wholesale too: pages that far
// apart ARE wholesale differences) and backtraces the path into ops.
// ---------------------------------------------------------------------------

/** Snapshot-row cap (backtrace memory ≈ (2D+1)×(D+1) Int32). */
const MYERS_SNAPSHOT_D_CAP = 1000;

export function lcsTokens(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  // Empty sides: pure insert / pure delete (also keeps the greedy's
  // zero-initialized termination check meaningful below).
  if (n === 0) return [{ kind: 'insert', aStart: 0, aEnd: 0, bStart: 0, bEnd: m }];
  if (m === 0) return [{ kind: 'delete', aStart: 0, aEnd: n, bStart: 0, bEnd: 0 }];
  // Diagonals live in [-m..n]; index k + off.
  const off = m + 1;
  const size = n + m + 3;

  // Pass 1 — D + budget.
  let budget = COMPARE_DIFF_BUDGET;
  let D = -1;
  {
    const v = new Int32Array(size);
    for (let d = 0; d <= n + m; d += 1) {
      for (let k = -d; k <= d; k += 2) {
        if (k < -m || k > n) continue;
        let x: number;
        if (k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off])) x = v[k + 1 + off];
        else x = v[k - 1 + off] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x += 1;
          y += 1;
          if (--budget < 0) throw new LcsBudgetError();
        }
        v[k + off] = x;
        if (--budget < 0) throw new LcsBudgetError();
      }
      if (v[n - m + off] >= n) {
        D = d;
        break;
      }
    }
  }
  if (D < 0) throw new LcsBudgetError(); // unreachable for finite inputs; guard
  if (D > MYERS_SNAPSHOT_D_CAP) throw new LcsBudgetError(); // snapshot bound

  // Pass 2 — the same deterministic greedy, one V snapshot per D row.
  const snap: Int32Array[] = new Array(D + 1);
  {
    const v = new Int32Array(size);
    for (let d = 0; d <= D; d += 1) {
      snap[d] = new Int32Array(2 * D + 3); // index k + D + 1
      for (let k = -d; k <= d; k += 2) {
        if (k < -m || k > n) continue;
        let x: number;
        if (k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off])) x = v[k + 1 + off];
        else x = v[k - 1 + off] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x += 1;
          y += 1;
        }
        v[k + off] = x;
        snap[d][k + D + 1] = x;
      }
      if (v[n - m + off] >= n) break;
    }
  }

  // Backtrace: walk the path from the end, emitting per-step ops reversed.
  const rev: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = D; d >= 1; d -= 1) {
    const k = x - y;
    const prev = snap[d - 1];
    const fromInsert = k === -d || (k !== d && prev[k - 1 + D + 1] < prev[k + 1 + D + 1]);
    const pk = fromInsert ? k + 1 : k - 1;
    const px = prev[pk + D + 1];
    const py = px - pk;
    const sx = fromInsert ? px : px + 1;
    const sy = fromInsert ? py + 1 : py;
    // Walk order is backward, so the equal snake (sx→x) is pushed BEFORE
    // the step op — the final reversal then yields document order.
    if (x > sx) {
      rev.push({ kind: 'equal', aStart: sx, aEnd: x, bStart: sy, bEnd: y });
    }
    if (fromInsert) {
      // Vertical move: b[py] inserted (x stays, y advances).
      rev.push({ kind: 'insert', aStart: px, aEnd: px, bStart: py, bEnd: py + 1 });
    } else {
      // Horizontal move: a[px] deleted (x advances, y stays).
      rev.push({ kind: 'delete', aStart: px, aEnd: px + 1, bStart: py, bEnd: py });
    }
    x = px;
    y = py;
  }
  // The remaining leading run (the d=0 snake, i.e. the shared prefix the
  // path walked on diagonal 0 before the first non-diagonal move).
  if (x > 0) {
    rev.push({ kind: 'equal', aStart: 0, aEnd: x, bStart: 0, bEnd: y });
  }
  const ops = rev.reverse();
  // Merge adjacent same-kind ops (backtrace emits per-step singles; the
  // reflow filter and the marks work on maximal hunks).
  const merged: DiffOp[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.kind === op.kind && last.aEnd === op.aStart && last.bEnd === op.bStart) {
      last.aEnd = op.aEnd;
      last.bEnd = op.bEnd;
    } else {
      merged.push(op);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Reflow filter + pair assembly.
// ---------------------------------------------------------------------------

/** Two ADJACENT delete+insert hunks whose whitespace-collapsed normalized
 * concatenations are identical are pure re-wrap — suppressed. A real word
 * change inside a re-wrap breaks the equality and shows. Handles both
 * hunk orders (delete-then-insert and insert-then-delete). */
function suppressReflow(ops: DiffOp[], a: string[], b: string[]): { ops: DiffOp[]; suppressed: number } {
  const collapsedOf = (tokens: string[], from: number, to: number): string =>
    tokens.slice(from, to).join('').replace(/\s+/g, '');
  const outOps: DiffOp[] = [];
  let suppressed = 0;
  let i = 0;
  while (i < ops.length) {
    const cur = ops[i]!;
    const next = ops[i + 1];
    if (
      next !== undefined &&
      ((cur.kind === 'delete' && next.kind === 'insert') || (cur.kind === 'insert' && next.kind === 'delete'))
    ) {
      const del = cur.kind === 'delete' ? cur : next;
      const ins = cur.kind === 'insert' ? cur : next;
      if (collapsedOf(a, del.aStart, del.aEnd) === collapsedOf(b, ins.bStart, ins.bEnd)) {
        suppressed += 1;
        i += 2;
        continue;
      }
    }
    outOps.push(cur);
    i += 1;
  }
  return { ops: outOps, suppressed };
}

/** Compare ONE pair of word arrays into a PagePair (marks + wholesale
 * bail). Exported for specs; runCompare composes pages through here. */
export function comparePagePair(oldPage: number, newPage: number, oldWords: CompWord[], newWords: CompWord[]): PagePair {
  const pair: PagePair = { oldPage, newPage, inserted: [], removed: [] };
  try {
    const oldNorm = oldWords.map((w) => w.norm);
    const newNorm = newWords.map((w) => w.norm);
    const ops = lcsTokens(oldNorm, newNorm);
    const filtered = suppressReflow(ops, oldNorm, newNorm);
    for (const op of filtered.ops) {
      if (op.kind === 'delete') pair.removed.push(...oldWords.slice(op.aStart, op.aEnd));
      else if (op.kind === 'insert') pair.inserted.push(...newWords.slice(op.bStart, op.bEnd));
    }
    pair.wholesale = undefined;
  } catch (e) {
    if (e instanceof LcsBudgetError) {
      pair.wholesale = {
        oldText: oldWords.map((w) => w.text).join(' '),
        newText: newWords.map((w) => w.text).join(' '),
      };
    } else {
      throw e;
    }
  }
  return pair;
}

/** Two full page-input arrays → CompareResult (alignment + per-pair diff
 * + stats). Pure and deterministic: same inputs ⇒ deep-equal result. */
export function compareDocuments(oldPages: ComparePageInput[], newPages: ComparePageInput[]): CompareResult {
  if (oldPages.length > COMPARE_PAGE_CAP || newPages.length > COMPARE_PAGE_CAP) {
    throw new CompareCapError(
      `compare is capped at ${COMPARE_PAGE_CAP} pages per document (got ${oldPages.length} / ${newPages.length})`,
    );
  }
  const countWords = (pages: ComparePageInput[], doc: 'A' | 'B'): CompWord[][] =>
    pages.map((p, i) => {
      const words = wordsFromPage(p);
      if (words.length > COMPARE_WORDS_PER_PAGE) {
        throw new CompareCapError(
          `${doc === 'A' ? 'Old' : 'New'} page ${i + 1} has ${words.length} words — above the ${COMPARE_WORDS_PER_PAGE}-word safety cap`,
        );
      }
      return words;
    });
  const oldWords = countWords(oldPages, 'A');
  const newWords = countWords(newPages, 'B');

  const oldDigests = oldWords.map(pageDigest);
  const newDigests = newWords.map(pageDigest);
  const pageOps = lcsTokens(oldDigests, newDigests);
  const anyAligned = pageOps.some((op) => op.kind === 'equal');

  const pairs: PagePair[] = [];
  const addedPages: number[] = [];
  const removedPages: number[] = [];
  if (anyAligned) {
    for (const op of pageOps) {
      if (op.kind === 'equal') {
        // One pair PER aligned page (an equal op can span a multi-page run).
        for (let i = op.aStart; i < op.aEnd; i += 1) {
          const j = op.bStart + (i - op.aStart);
          pairs.push(comparePagePair(i + 1, j + 1, oldWords[i]!, newWords[j]!));
        }
      } else if (op.kind === 'delete') {
        for (let i = op.aStart; i < op.aEnd; i += 1) {
          removedPages.push(i + 1);
          pairs.push({ oldPage: i + 1, newPage: null, inserted: [], removed: [] });
        }
      } else {
        for (let i = op.bStart; i < op.bEnd; i += 1) {
          addedPages.push(i + 1);
          pairs.push({ oldPage: 0, newPage: i + 1, inserted: [], removed: [] });
        }
      }
    }
  } else {
    // Unaligned fallback (red-team C8): honest notice + INDEX pairing —
    // never a silently useless all-added/all-removed report.
    const shared = Math.min(oldWords.length, newWords.length);
    for (let i = 0; i < shared; i += 1) {
      pairs.push(comparePagePair(i + 1, i + 1, oldWords[i]!, newWords[i]!));
    }
    for (let i = shared; i < oldWords.length; i += 1) removedPages.push(i + 1);
    for (let i = shared; i < newWords.length; i += 1) addedPages.push(i + 1);
  }

  let wordsAdded = 0;
  let wordsRemoved = 0;
  let suppressed = 0;
  let pagesChanged = 0;
  for (const p of pairs) {
    if (p.inserted.length > 0 || p.removed.length > 0 || p.wholesale) pagesChanged += 1;
    wordsAdded += p.inserted.length;
    wordsRemoved += p.removed.length;
  }
  // `unaligned` fires only when alignment had a REAL choice to get wrong
  // (≥2 pages per side): with one page each, index pairing IS alignment
  // and the honest notice would be noise.
  const unaligned = !anyAligned && Math.min(oldPages.length, newPages.length) > 1;
  return { pairs, addedPages, removedPages, unaligned, stats: { pagesChanged, wordsAdded, wordsRemoved, suppressed } };
}
