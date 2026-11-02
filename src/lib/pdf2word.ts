/*
 * PDF → Word conversion engine (v0.10.0 phase 4, plan 261102-1005).
 *
 * Digital text-layer PDFs: positional text items (getVisualTextItems,
 * visual space y-down) → baseline rows → table band detection (cell
 * alignment) → recursive XY-cut reading order → paragraphs + headings +
 * bullet/numbered lists → per-page markdown in the SAME dialect the AI
 * OCR path already emits (headings, flat lists, pipe tables) so the
 * existing markdownToDocx path converts it untouched. Scanned pages route
 * through the AI OCR seam the CALLER wires (the tool, like the OCR tool
 * does) — this module never touches a model.
 *
 * Algorithms re-expressed from published descriptions only (Nagy et al.
 * XY-cut; pdfminer LAParams as the tuning-surface reference; pdfplumber's
 * text strategy for alignment clustering) — no code from pdf2md/pdfminer/
 * camelot/PyMuPDF; MIT/AGPL boundary per the repo rule. The v0.9.0
 * markdown-table split contract applies downstream: cells escape literal
 * pipes as `\|` (ai-markdown unescapes on re-split).
 *
 * Pure lib: no React, no i18n, no worker imports. The composer's engine
 * calls arrive as injected functions, so the whole file is node-testable.
 */

import type { DocxPages } from './markdown-docx';
import type { VisualTextItem } from '../engine/pdfjs';

// ---------------------------------------------------------------------------
// Budgets (RED-TEAM F1) — typed refusals, never silent truncation.
// ---------------------------------------------------------------------------

/** DOCX runs are capped like OCR_PAGE_CAP (F9): a 100-page document is a
 * real use case; a 1000-page one belongs in a desktop word processor. */
export const PDF2WORD_PAGE_CAP = 100;

/** Per-page text-item cap. A page above it is hostile (generator spam,
 * CVE-class PDFs) — refuse the run instead of freezing the tab. */
export const PDF2WORD_MAX_ITEMS_PER_PAGE = 20000;

/** Census threshold (chars per page): a sampled page under this is a scan.
 * Same heuristic class as the OCR tool's first-page text.length >= 32. */
export const PDF2WORD_CENSUS_MIN_CHARS = 32;

/** Coordinates beyond this are garbage (or an attack); the item is dropped
 * at the boundary, per F1's sanity rule. */
const P2W_COORD_LIMIT = 1e6;

/** Boundary sanity (F1): drop items with non-finite or absurd coordinates
 * before any layout math sees them. */
export function sanitizeItems(items: Item[]): Item[] {
  const ok = (v: number) => Number.isFinite(v) && Math.abs(v) <= P2W_COORD_LIMIT;
  return items.filter((i) => ok(i.x0) && ok(i.x1) && ok(i.baseline) && ok(i.size) && i.size > 0);
}

export class Pdf2WordPageCapError extends Error {
  constructor(pageCount: number) {
    super(`PDF has ${pageCount} pages — PDF→Word is capped at ${PDF2WORD_PAGE_CAP} pages per run`);
    this.name = 'Pdf2WordPageCapError';
  }
}

export class Pdf2WordItemCapError extends Error {
  constructor(page: number, items: number) {
    super(
      `Page ${page} has ${items} text items — above the ${PDF2WORD_MAX_ITEMS_PER_PAGE} item safety cap`,
    );
    this.name = 'Pdf2WordItemCapError';
  }
}

/** Scan (or mixed-with-scan) input without a caller-wired AI seam. */
export class Pdf2WordScanError extends Error {
  constructor(readonly scanPages: number[]) {
    super(
      scanPages.length === 1
        ? `Page ${scanPages[0]} is a scanned image — converting it needs the on-device AI engine`
        : `Pages ${scanPages.join(', ')} are scanned images — converting them needs the on-device AI engine`,
    );
    this.name = 'Pdf2WordScanError';
  }
}

// ---------------------------------------------------------------------------
// Layout primitives (spike-pdf2word-2026-11-02 lessons encoded).
// ---------------------------------------------------------------------------

type Item = VisualTextItem;
type Row = { baseline: number; items: Item[] };
type ColumnEdge = { x: number; hits: number };

function vSpan(items: Item[]): number {
  if (items.length === 0) return 0;
  const top = Math.min(...items.map((f) => f.baseline - f.size));
  const bottom = Math.max(...items.map((f) => f.baseline + f.size * 0.25));
  return bottom - top;
}

/** Baseline clustering with a font-size-derived tolerance (±35% of the
 * row's size — the groupRuns band rule, visual space). */
export function clusterRows(items: Item[]): Row[] {
  const rows: Row[] = [];
  for (const it of items) {
    const tol = Math.max(2, it.size * 0.35);
    const row = rows.find((r) => Math.abs(r.baseline - it.baseline) <= tol);
    if (row) {
      row.items.push(it);
      row.baseline = (row.baseline * (row.items.length - 1) + it.baseline) / row.items.length;
    } else {
      rows.push({ baseline: it.baseline, items: [it] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x0 - b.x0);
  return rows.sort((a, b) => a.baseline - b.baseline);
}

/**
 * Recursive XY-cut (spike parameters, not first principles): split on the
 * widest vertical whitespace band whose sides BOTH span ≥60% of the region
 * height (a column gutter — only when the region is tall enough to be
 * columns, ≥3× body size, so a table row never qualifies), else on the
 * widest horizontal gap ≥0.9× size (a section break — line leading never
 * splits). Leaves come back top→bottom, then left→right.
 */
export function xyCut(
  items: Item[],
  bodySize: number,
  opts: { minGutter?: number; gutterCover?: number; maxDepth?: number; gapFactor?: number } = {},
  depth = 0,
): Item[][] {
  const { minGutter = 18, gutterCover = 0.6, maxDepth = 6, gapFactor = 0.9 } = opts;
  if (depth >= maxDepth || items.length <= 1) return [items];
  const height = vSpan(items);

  if (height >= 3 * bodySize) {
    const sorted = [...items].sort((a, b) => a.x0 - b.x0);
    const gaps: { start: number; end: number; width: number }[] = [];
    let cursor = sorted[0]!.x0;
    for (const f of sorted) {
      if (f.x0 - cursor >= minGutter) gaps.push({ start: cursor, end: f.x0, width: f.x0 - cursor });
      cursor = Math.max(cursor, f.x1);
    }
    const gutters = gaps.filter((g) => {
      const left = items.filter((f) => f.x1 <= g.start + 0.5);
      const right = items.filter((f) => f.x0 >= g.end - 0.5);
      return vSpan(left) >= gutterCover * height && vSpan(right) >= gutterCover * height;
    });
    if (gutters.length > 0) {
      const g = gutters.reduce((a, b) => (b.width > a.width ? b : a));
      const left = items.filter((f) => f.x1 <= g.start + 0.5);
      const right = items.filter((f) => f.x0 >= g.end - 0.5);
      return [...xyCut(left, bodySize, opts, depth + 1), ...xyCut(right, bodySize, opts, depth + 1)];
    }
  }

  const byY = clusterRows(items);
  let best: { at: number; gap: number } | null = null;
  for (let i = 1; i < byY.length; i += 1) {
    const prev = byY[i - 1]!;
    const cur = byY[i]!;
    const gap = cur.baseline - prev.baseline - Math.max(cur.items[0]!.size, prev.items[0]!.size);
    if (gap >= gapFactor * Math.max(cur.items[0]!.size, prev.items[0]!.size)) {
      if (!best || gap > best.gap) best = { at: i, gap };
    }
  }
  if (best) {
    const flatTop = byY.slice(0, best.at).flatMap((r) => r.items);
    const flatBottom = byY.slice(best.at).flatMap((r) => r.items);
    if (flatTop.length > 0 && flatBottom.length > 0) {
      return [
        ...xyCut(flatTop, bodySize, opts, depth + 1),
        ...xyCut(flatBottom, bodySize, opts, depth + 1),
      ];
    }
  }
  return [items];
}

/**
 * Table band detection over cell ALIGNMENT only (spike probe: recovers the
 * ruled invoice grid without reading ruling lines). The page is first cut
 * into bands by row pitch (break where pitch > 1.8× the median pitch — a
 * table's rows sit at one tight pitch, surrounded by larger gaps to body
 * text), then a band is a table when: ≥3 rows, ≥2 column edges (left-edge
 * clustering, ≥50% row coverage), EVERY column's median cell width ≤65% of
 * the gap to the next edge, and ≥3 rows carry ≥2 cells. Two-column BODY
 * text fills its columns (right column measured 0.92 on the fixture) while
 * table cells stay short (invoice ≤0.5) — the coverage guard is what keeps
 * body columns from false-tabulating. Rows with <2 cells return to the
 * text flow (a stray full-width line inside the band is not table data).
 */
export function detectTable(items: Item[]): { rows: string[][]; items: Item[] } | null {
  const allRows = clusterRows(items);
  if (allRows.length < 3) return null;
  const pitches: number[] = [];
  for (let i = 1; i < allRows.length; i += 1) {
    pitches.push(allRows[i]!.baseline - allRows[i - 1]!.baseline);
  }
  const sortedPitches = [...pitches].sort((a, b) => a - b);
  const medianPitch = sortedPitches[Math.floor(sortedPitches.length / 2)]!;
  const breakOver = 1.8 * medianPitch;
  const bands: Row[][] = [];
  let band: Row[] = [allRows[0]!];
  for (let i = 1; i < allRows.length; i += 1) {
    if (pitches[i - 1]! > breakOver) {
      bands.push(band);
      band = [];
    }
    band.push(allRows[i]!);
  }
  bands.push(band);

  for (const rows of bands) {
    if (rows.length < 3) continue;
    const edges: ColumnEdge[] = [];
    for (const r of rows) {
      for (const f of r.items) {
        const hit = edges.find((e) => Math.abs(e.x - f.x0) <= 3);
        if (hit) hit.hits += 1;
        else edges.push({ x: f.x0, hits: 1 });
      }
    }
    const minHits = Math.ceil(rows.length * 0.5);
    const cols = edges.filter((e) => e.hits >= minHits).sort((a, b) => a.x - b.x);
    if (cols.length < 2) continue;

    let covered = true;
    for (const [i, col] of cols.entries()) {
      // The LAST column has no right bound in text geometry (the drawn
      // ruling line lies beyond the longest cell) — its coverage test is
      // self-defeating and is skipped; interior columns carry the guard.
      if (i + 1 >= cols.length) break;
      const next = cols[i + 1]!.x;
      const width = next - col.x;
      const cells = rows
        .map((r) => r.items.find((f) => Math.abs(f.x0 - col.x) <= 3))
        .filter((f): f is Item => !!f)
        .map((f) => f.x1 - f.x0);
      if (cells.length === 0) {
        covered = false;
        break;
      }
      cells.sort((a, b) => a - b);
      const median = cells[Math.floor(cells.length / 2)]!;
      if (median > 0.65 * width) {
        covered = false;
        break;
      }
    }
    if (!covered) continue;

    const grid: { cells: string[]; items: Item[] }[] = rows.map((r) => {
      const cells = cols.map(() => '');
      const used: Item[] = [];
      for (const f of r.items) {
        const ci = cols.findIndex(
          (e, i) => f.x0 >= e.x - 3 && (i + 1 >= cols.length || f.x0 < cols[i + 1]!.x - 3),
        );
        if (ci < 0) continue;
        // Cells are single-line by construction (pdf.js items never carry
        // newlines); whitespace collapses here. Pipe escaping happens once,
        // at the emitter (the single choke point every table path shares).
        const text = f.str.replace(/\s+/g, ' ').trim();
        cells[ci] = cells[ci] ? `${cells[ci]} ${text}` : text;
        used.push(f);
      }
      return { cells, items: used };
    });
    const full = grid.filter((g) => g.cells.filter((c) => c !== '').length >= 2);
    if (full.length < 3) continue;
    return {
      rows: full.map((g) => g.cells),
      items: full.flatMap((g) => g.items),
    };
  }
  return null;
}

/** Pipe-table emission: `| a | b |` + `---` separator (the AI-path table
 * dialect; markdownToSafeHtml builds thead/tbody from it). The emitter is
 * the single escaping choke point: literal pipes become `\|` (the
 * downstream split contract unescapes on re-split) and whitespace collapses
 * so a hostile newline can never tear a row — F9. */
export function emitTableMarkdown(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  const clean = rows.map((r) =>
    r.map((c) => c.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|')),
  );
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const [head, ...rest] = clean.map(pad);
  const lines = [
    `| ${head!.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...rest.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Region → markdown (headings, lists, paragraphs).
// ---------------------------------------------------------------------------

const BULLET_GLYPHS = /^[•▪◦‣·*]\s+/;
const NUMBERED = /^\d{1,2}[.)]\s+/;
const BOLD_FONT = /bold|black|heavy/i;

type Line = { text: string; x0: number; baseline: number; size: number; bold: boolean };

function regionLines(items: Item[]): Line[] {
  return clusterRows(items)
    .map((r) => {
      let text = '';
      let prev: Item | null = null;
      for (const it of r.items) {
        if (prev && it.x0 - prev.x1 > Math.max(1, prev.size * 0.2) && !/\s$/.test(text) && !/^\s/.test(it.str)) {
          text += ' ';
        }
        text += it.str;
        prev = it;
      }
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        x0: Math.min(...r.items.map((i) => i.x0)),
        baseline: r.baseline,
        size: Math.max(...r.items.map((i) => i.size)),
        bold: r.items.some((i) => BOLD_FONT.test(i.fontName)),
      };
    })
    .filter((l) => l.text.length > 0);
}

function modeOf(sizes: number[]): number {
  const counts = new Map<number, number>();
  for (const s of sizes) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = 11;
  let bestN = 0;
  for (const [s, n] of counts) {
    if (n > bestN) {
      best = s;
      bestN = n;
    }
  }
  return best;
}

/** One leaf region → markdown blocks. Heading grades cut paragraphs and
 * stand alone (spike lesson #6); list glyphs/numbers open list items
 * (nesting via 12pt indent steps, capped at 3 like the heading clamp). */
function regionToMarkdown(items: Item[], bodySize: number): string {
  const lines = regionLines(items);
  const isHeading = (l: Line) => l.size / bodySize >= 1.15;
  const out: string[] = [];
  let para: Line[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    const text = para.map((l) => l.text).join(' ');
    const size = Math.max(...para.map((l) => l.size));
    const ratio = size / bodySize;
    if (ratio >= 1.35) out.push(`# ${text}`);
    else if (ratio >= 1.15) out.push(`## ${text}`);
    else if (para.length === 1 && para[0]!.bold && text.length < 80) out.push(`### ${text}`);
    else out.push(text);
    para = [];
  };
  for (const l of lines) {
    const bullet = BULLET_GLYPHS.exec(l.text);
    const numbered = NUMBERED.exec(l.text);
    if (isHeading(l)) {
      flushPara();
      const ratio = l.size / bodySize;
      out.push(`${ratio >= 1.35 ? '#' : '##'} ${l.text}`);
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      const level = Math.min(3, Math.max(0, Math.round((l.x0 - lines[0]!.x0) / 12)));
      const marker = bullet ? '- ' : `${numbered![0]!.replace(/[.)]\s$/, '.')} `;
      const indent = '  '.repeat(level);
      const body = (bullet ? l.text.slice(bullet[0].length) : l.text.slice(numbered![0].length)).trim();
      out.push(`${indent}${marker}${body}`);
      continue;
    }
    const prev = para[para.length - 1];
    const gap = prev ? l.baseline - prev.baseline - Math.max(l.size, prev.size) : Infinity;
    if (prev && gap <= 0.55 * l.size) {
      para.push(l);
    } else {
      flushPara();
      para.push(l);
    }
  }
  flushPara();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Page pipeline.
// ---------------------------------------------------------------------------

/** Body size = the modal rounded font size on the page (heading ratios
 * measure against it). */
export function pageBodySize(items: Item[]): number {
  return modeOf(items.map((i) => Math.round(i.size * 2) / 2));
}

/** One page's visual items → markdown (table pass first, XY-cut for the
 * rest; content above/below the table band keeps its reading order). This
 * is the per-page stage the composer awaits in a loop. */
export function pageToMarkdown(items: Item[]): string {
  items = sanitizeItems(items);
  if (items.length === 0) return '';
  const bodySize = pageBodySize(items);
  const blocks: string[] = [];
  const emitRegions = (set: Item[]): void => {
    if (set.length === 0) return;
    for (const region of xyCut(set, bodySize)) {
      const md = regionToMarkdown(region, bodySize);
      if (md) blocks.push(md);
    }
  };
  const table = detectTable(items);
  if (table) {
    const used = new Set(table.items);
    const bandTop = Math.min(...table.items.map((f) => f.baseline));
    const bandBottom = Math.max(...table.items.map((f) => f.baseline));
    emitRegions(items.filter((f) => !used.has(f) && f.baseline < bandTop));
    blocks.push(emitTableMarkdown(table.rows));
    emitRegions(items.filter((f) => f.baseline > bandBottom));
    const inBand = items.filter((f) => !used.has(f) && f.baseline >= bandTop && f.baseline <= bandBottom);
    emitRegions(inBand); // off-grid stragglers on table baselines
  } else {
    emitRegions(items);
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Mode census (RED-TEAM F1: explicit sampling) + composer.
// ---------------------------------------------------------------------------

/** Sample = first + middle + last page (F1: the rule is explicit; the cost
 * of MIXED resolution is that interior scan pages only surface at convert
 * time, where per-page routing still catches them). */
export function censusSample(pageCount: number): number[] {
  if (pageCount <= 0) return [];
  if (pageCount === 1) return [1];
  if (pageCount === 2) return [1, 2];
  const mid = Math.ceil(pageCount / 2);
  return [1, mid, pageCount];
}

export function censusMode(charsPerPage: number[]): 'digital' | 'scan' | 'mixed' {
  const sampled = charsPerPage.map((c) => c >= PDF2WORD_CENSUS_MIN_CHARS);
  if (sampled.every((s) => s)) return 'digital';
  if (sampled.every((s) => !s)) return 'scan';
  return 'mixed';
}

export interface Pdf2WordRunOptions {
  /** 1-based page count (from getPageCount — the caller's engine load). */
  pageCount: number;
  /** Page-picker selection: sorted 1-based pages replacing the full loop
   *  (the ThumbnailStrip picker; null/undefined = all pages). */
  pages?: number[];
  /** Per-page extraction (composer never imports the engine directly). */
  extractPage: (page: number) => Promise<Item[]>;
  /** DOCX emitter (the tool injects engine.markdownToDocx; tests stub it). */
  toDocx: (pages: DocxPages) => Promise<Uint8Array>;
  /** AI seam for scan pages — the tool wires runAiPages + its markdown
   * converter exactly like the OCR tool does; unit tests stub it. */
  aiConvertPages?: (pages: number[]) => Promise<string[]>;
  onProgress?: (done: number, total: number) => void;
}

export interface Pdf2WordResult {
  docx: Uint8Array;
  mode: 'digital' | 'scan' | 'mixed';
  /** Per-page markdown in page order (diagnostics + tests). */
  markdown: string[];
  scanPagesConverted: number[];
}

/**
 * Orchestrate one conversion. Digital pages convert from the text layer;
 * scan pages (census char floor) go through the AI seam; the census mode
 * comes from the first/middle/last sample while ROUTING stays per-page.
 * Awaits page-by-page (never one giant main-thread loop). With `pages`,
 * everything (extraction, census, markdown, DOCX texts) runs over the
 * selection only.
 */
export async function runPdf2Word(opts: Pdf2WordRunOptions): Promise<Pdf2WordResult> {
  const { pageCount, extractPage, toDocx } = opts;
  if (pageCount > PDF2WORD_PAGE_CAP) throw new Pdf2WordPageCapError(pageCount);
  const selection = opts.pages
    ? [...new Set(opts.pages)].sort((a, b) => a - b).filter((p) => p >= 1 && p <= pageCount)
    : null;
  const queue = selection ?? Array.from({ length: pageCount }, (_, i) => i + 1);
  if (queue.length === 0) throw new Error('pdf2word: empty page selection');
  const total = queue.length;

  const chars: number[] = [];
  const pagesItems = new Map<number, Item[]>();
  for (const [i, p] of queue.entries()) {
    const items = await extractPage(p);
    if (items.length > PDF2WORD_MAX_ITEMS_PER_PAGE) throw new Pdf2WordItemCapError(p, items.length);
    pagesItems.set(p, items);
    chars.push(items.reduce((n, item) => n + item.str.length, 0));
    opts.onProgress?.(i + 1, total * 2); // extraction half + conversion half
  }
  // censusSample returns 1-based positions WITHIN the queue; chars is
  // 0-indexed over the same queue.
  const mode = censusMode(censusSample(total).map((p) => chars[p - 1]!));
  const scanPages = queue.filter((_, i) => chars[i]! < PDF2WORD_CENSUS_MIN_CHARS);

  const markdown: string[] = [];
  const converted: number[] = [];
  if (scanPages.length > 0) {
    if (!opts.aiConvertPages) throw new Pdf2WordScanError(scanPages);
    const aiMd = await opts.aiConvertPages(scanPages);
    for (const [i, p] of queue.entries()) {
      const si = scanPages.indexOf(p);
      if (si >= 0) {
        markdown.push(aiMd[si] ?? '');
        converted.push(p);
      } else {
        markdown.push(pageToMarkdown(pagesItems.get(p)!));
      }
      opts.onProgress?.(total + i + 1, total * 2);
    }
  } else {
    for (const [i, p] of queue.entries()) {
      markdown.push(pageToMarkdown(pagesItems.get(p)!));
      opts.onProgress?.(total + i + 1, total * 2);
    }
  }

  const docx = await toDocx({ texts: markdown });
  return { docx, mode, markdown, scanPagesConverted: converted };
}
