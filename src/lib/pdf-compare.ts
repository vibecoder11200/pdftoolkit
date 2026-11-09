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
  const oldWords = oldPages.map(wordsFromPage);
  const newWords = newPages.map(wordsFromPage);
  for (const [i, w] of oldWords.entries()) {
    if (w.length > COMPARE_WORDS_PER_PAGE) {
      throw new CompareCapError(`Old page ${i + 1} has ${w.length} words — above the ${COMPARE_WORDS_PER_PAGE}-word safety cap`);
    }
  }
  for (const [i, w] of newWords.entries()) {
    if (w.length > COMPARE_WORDS_PER_PAGE) {
      throw new CompareCapError(`New page ${i + 1} has ${w.length} words — above the ${COMPARE_WORDS_PER_PAGE}-word safety cap`);
    }
  }
  return compareWordArrays(oldWords, newWords);
}

/** Word-multiset similarity for gap-region pairing: |shared norms| /
 * max(|A|,|B|). Deterministic and cheap (Set intersection). 0.5 says a
 * page that kept at least half its words is a REVISION of the other side's
 * page (word diff still decides the marks); anything colder is a genuine
 * replace (removed + added banners, honest structure). */
const GAP_SIMILARITY_MIN = 0.5;
function gapSimilarity(a: CompWord[], b: CompWord[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const setB = new Set(b.map((w) => w.norm));
  let shared = 0;
  const seen = new Set<string>();
  for (const w of a) {
    if (setB.has(w.norm) && !seen.has(w.norm)) {
      seen.add(w.norm);
      shared += 1;
    }
  }
  return shared / maxLen;
}

/** Pre-derived word arrays → CompareResult (the shared assembly both the
 * pure entry and runCompare go through — no second alignment code path). */
export function compareWordArrays(oldWords: CompWord[][], newWords: CompWord[][]): CompareResult {

  const oldDigests = oldWords.map(pageDigest);
  const newDigests = newWords.map(pageDigest);
  const pageOps = lcsTokens(oldDigests, newDigests);
  const anyAligned = pageOps.some((op) => op.kind === 'equal');

  const pairs: PagePair[] = [];
  const addedPages: number[] = [];
  const removedPages: number[] = [];
  if (anyAligned) {
    // GAP-REGION PAIRING (v0.11.0 phase 7 repair): the exact-text digest
    // unaligns any page with even one word changed — the flagship scenario
    // (edit one word, add a page) would report removed+added banners with
    // NO word marks. So unmatched A/B pages that sit in the SAME region
    // between digest anchors pair up when their word sets are still
    // similar; the word diff then decides the overlay. Leftovers (genuine
    // page insert/remove, or a replaced page below the similarity floor)
    // keep the honest banners.
    let regionA: number[] = [];
    let regionB: number[] = [];
    const flushRegion = (): void => {
      const used = new Set<number>();
      for (const ai of regionA) {
        let bestJ = -1;
        let bestSim = -1;
        for (const bj of regionB) {
          if (used.has(bj)) continue;
          const sim = gapSimilarity(oldWords[ai]!, newWords[bj]!);
          // Strict > keeps the FIRST candidate on similarity ties — regionB
          // iterates ascending, so that is always the lowest page index.
          if (sim > bestSim) {
            bestSim = sim;
            bestJ = bj;
          }
        }
        if (bestJ >= 0 && bestSim >= GAP_SIMILARITY_MIN) {
          used.add(bestJ);
          pairs.push(comparePagePair(ai + 1, bestJ + 1, oldWords[ai]!, newWords[bestJ]!));
        } else {
          removedPages.push(ai + 1);
          pairs.push({ oldPage: ai + 1, newPage: null, inserted: [], removed: [] });
        }
      }
      for (const bj of regionB) {
        if (used.has(bj)) continue;
        addedPages.push(bj + 1);
        pairs.push({ oldPage: 0, newPage: bj + 1, inserted: [], removed: [] });
      }
      regionA = [];
      regionB = [];
    };
    for (const op of pageOps) {
      if (op.kind === 'equal') {
        flushRegion();
        // One pair PER aligned page (an equal op can span a multi-page run).
        for (let i = op.aStart; i < op.aEnd; i += 1) {
          const j = op.bStart + (i - op.aStart);
          pairs.push(comparePagePair(i + 1, j + 1, oldWords[i]!, newWords[j]!));
        }
      } else if (op.kind === 'delete') {
        for (let i = op.aStart; i < op.aEnd; i += 1) regionA.push(i);
      } else {
        for (let i = op.bStart; i < op.bEnd; i += 1) regionB.push(i);
      }
    }
    flushRegion();
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
  const unaligned = !anyAligned && Math.min(oldWords.length, newWords.length) > 1;
  return { pairs, addedPages, removedPages, unaligned, stats: { pagesChanged, wordsAdded, wordsRemoved, suppressed } };
}

// ---------------------------------------------------------------------------
// Streaming composer (phase 7) — the ONLY surface the tool drives.
// ---------------------------------------------------------------------------

/** Doc-token LRU cache (red-team F5): the tool owns ONE cache per slot,
 * keyed by PAGE within the slot's CURRENT document; the cache stores the
 * derived CompWords (not raw items — a 2×100-page adversarial pair would
 * otherwise retain ~4M item objects), and the swap button swaps slot
 * REFERENCES — never relabels cache keys (the swap-identity spec pins
 * swap → re-run == fresh-swapped). */
export class WordLru {
  private map = new Map<number, CompWord[]>();

  constructor(private readonly max = 32) {}

  get(page: number): CompWord[] | undefined {
    const hit = this.map.get(page);
    if (hit !== undefined) {
      // Touch for LRU order.
      this.map.delete(page);
      this.map.set(page, hit);
    }
    return hit;
  }

  set(page: number, words: CompWord[]): void {
    if (this.map.has(page)) this.map.delete(page);
    this.map.set(page, words);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export interface CompareRunOptions {
  pageCountA: number;
  pageCountB: number;
  /** Caller-wired extraction (main-thread pdf.js through the tool). */
  getItems: (doc: 'a' | 'b', page: number) => Promise<VisualTextItem[]>;
  getSize: (doc: 'a' | 'b', page: number) => Promise<{ width: number; height: number }>;
  /** Slot-owned CompWord caches — pass the SAME instances across runs. */
  cacheA?: WordLru;
  cacheB?: WordLru;
  onProgress?: (done: number, total: number) => void;
  /** Cancel guard (the tool's genRef flip). */
  shouldContinue?: () => boolean;
}

export class CompareCancelled extends Error {
  constructor() {
    super('pdf-compare: run cancelled');
    this.name = 'CompareCancelled';
  }
}

/** Stream one comparison: extract both docs page-by-page (cached, bounded,
 * cancelable), then align + diff through the shared assembly. Typed cap
 * refusals; a cancelled run rejects with CompareCancelled. */
export async function runCompare(opts: CompareRunOptions): Promise<CompareResult> {
  if (opts.pageCountA > COMPARE_PAGE_CAP || opts.pageCountB > COMPARE_PAGE_CAP) {
    throw new CompareCapError(
      `compare is capped at ${COMPARE_PAGE_CAP} pages per document (got ${opts.pageCountA} / ${opts.pageCountB})`,
    );
  }
  const extract = async (
    doc: 'a' | 'b',
    count: number,
    cache: WordLru | undefined,
    label: 'Old' | 'New',
  ): Promise<CompWord[][]> => {
    const out: CompWord[][] = [];
    for (let p = 1; p <= count; p += 1) {
      if (opts.shouldContinue && !opts.shouldContinue()) throw new CompareCancelled();
      const cached = cache?.get(p);
      if (cached) {
        out.push(cached);
        continue;
      }
      const [items, size] = await Promise.all([opts.getItems(doc, p), opts.getSize(doc, p)]);
      const words = wordsFromPage({ items, width: size.width, height: size.height });
      if (words.length > COMPARE_WORDS_PER_PAGE) {
        throw new CompareCapError(
          `${label} page ${p} has ${words.length} words — above the ${COMPARE_WORDS_PER_PAGE}-word safety cap`,
        );
      }
      cache?.set(p, words);
      out.push(words);
      opts.onProgress?.(out.length, count * 2);
    }
    return out;
  };
  const wordsA = await extract('a', opts.pageCountA, opts.cacheA, 'Old');
  const wordsB = await extract('b', opts.pageCountB, opts.cacheB, 'New');
  const result = compareWordArrays(wordsA, wordsB);
  opts.onProgress?.(opts.pageCountA + opts.pageCountB, opts.pageCountA + opts.pageCountB);
  return result;
}

// ---------------------------------------------------------------------------
// Compare marks + text diff (v0.11.0 phase 8).
//
// The annotated export draws del/ins bands over BOTH documents; marks are
// top-left-origin FRACTIONS of the visible page (repo convention — the op
// applies the named flip). The coalescer is PURE and lives here (plan P8):
// the engine op calls it before drawing, the tool reuses it for nothing
// (the overlay divs are already per-word), and the specs pin run-merging
// semantics. textDiffClauses wraps the EXPORTED lcsTokens (RED-TEAM C6:
// wrapper, never a sibling diff implementation) for the AI-OCR scan leg.
// ---------------------------------------------------------------------------

/** One drawn diff band. Top-left origin fractions of the VISIBLE page box
 * (RedactMark convention — the engine op owns the y-flip). */
export interface CompareMark {
  page: number;
  nx: number;
  nyTop: number;
  nw: number;
  nh: number;
  kind: 'del' | 'ins';
}

/** Adversarial bound (RED-TEAM S2): raw marks above this refuse BEFORE
 * drawing even though coalescing would shrink them — the caller is not
 * trusted to have coalesced. */
export const COMPARE_MARK_BUDGET = 50_000;

/** Merge adjacent same-row same-kind marks into band rects: one rect per
 * word-run, so a 100-page×20k-word adversarial diff draws runs, not 2M
 * ops. Pure + deterministic (sort → linear run-merge). Rows merge on a
 * vertical-band overlap (≥ half the smaller band); horizontal adjacency
 * tolerates a small fraction gap (word spacing). */
export function coalesceCompareMarks(marks: CompareMark[]): CompareMark[] {
  const sorted = [...marks].sort(
    (a, b) => a.page - b.page || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.nyTop - b.nyTop || a.nx - b.nx,
  );
  const out: CompareMark[] = [];
  const X_GAP = 0.012; // fraction — word boxes carry the redact pad and touch or slightly overlap; column gaps are ≥3× this
  const ROW_OVERLAP = 0.5;
  let cur: CompareMark | null = null;
  const canJoin = (a: CompareMark, b: CompareMark): boolean => {
    if (a.page !== b.page || a.kind !== b.kind) return false;
    const overlapTop = Math.max(a.nyTop, b.nyTop);
    const overlapBottom = Math.min(a.nyTop + a.nh, b.nyTop + b.nh);
    const overlap = Math.max(0, overlapBottom - overlapTop);
    const sameRow = overlap >= ROW_OVERLAP * Math.min(a.nh, b.nh);
    return sameRow && b.nx <= a.nx + a.nw + X_GAP;
  };
  const absorb = (a: CompareMark, b: CompareMark): CompareMark => {
    const top = Math.min(a.nyTop, b.nyTop);
    const bottom = Math.max(a.nyTop + a.nh, b.nyTop + b.nh);
    const left = Math.min(a.nx, b.nx);
    const right = Math.max(a.nx + a.nw, b.nx + b.nw);
    return { page: a.page, kind: a.kind, nx: left, nyTop: top, nw: right - left, nh: bottom - top };
  };
  for (const m of sorted) {
    if (cur && canJoin(cur, m)) cur = absorb(cur, m);
    else {
      if (cur) out.push(cur);
      cur = { ...m };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Text-level diff for AI-OCR scan pairs: whitespace tokens through the
 * exported lcsTokens, adjacent same-kind runs joined back into clause
 * strings. Pure — the clause panel renders these verbatim. */
export function textDiffClauses(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const a = oldText.split(/\s+/).filter((w) => w.length > 0);
  const b = newText.split(/\s+/).filter((w) => w.length > 0);
  const ops = lcsTokens(a, b);
  const added: string[] = [];
  const removed: string[] = [];
  for (const op of ops) {
    if (op.kind === 'delete') removed.push(op.aStart < op.aEnd ? a.slice(op.aStart, op.aEnd).join(' ') : '');
    else if (op.kind === 'insert') added.push(op.bStart < op.bEnd ? b.slice(op.bStart, op.bEnd).join(' ') : '');
  }
  return { added: added.filter((s) => s.length > 0), removed: removed.filter((s) => s.length > 0) };
}
