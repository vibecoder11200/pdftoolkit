/*
 * Phase-5 table region detection (plan 261112-0955). Builds ON TOP of the
 * exported pdf2word primitives (never re-implements them): band
 * segmentation happens here, then each band is handed to the SAME
 * detectTable the PDF→Word tool uses — parity tests pin that a
 * single-band page yields IDENTICAL rows through both entry points.
 *
 * Multi-region: pdf2word's detectTable returns only the FIRST qualifying
 * band (the markdown reading-order contract needs one table per region);
 * extraction wants every independent table band on the page.
 *
 * Rotation posture (plan: "explicit geometry or honest manual region
 * restriction; no mislocated text"): a rotated item's visual bbox does
 * not satisfy the x1 = x0 + advance assumption (v0.10.0 P2 note), so any
 * band containing a rotated item is REFUSED with a warning — its items
 * are reported, never approximated into cells.
 *
 * Pure lib: no React, no worker imports.
 */

import {
  PDF2WORD_MAX_ITEMS_PER_PAGE,
  clusterRows,
  detectTable,
  sanitizeItems,
} from '../pdf2word';
import type { VisualTextItem } from '../../engine/pdfjs';

type Item = VisualTextItem;

export interface TableRegion {
  /** Cell text exactly as the detector produced it (rawText in the model). */
  rows: string[][];
  /** Visual-space bbox (y-down) of the band's items — provenance. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  sourcePage: number;
  warnings: string[];
}

/** A band whose y-range contains rotated text: detection refused. */
export interface RefusedRegion {
  sourcePage: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  warning: 'rotated';
}

export class TableItemCapError extends Error {
  constructor(readonly itemCount: number) {
    super(`Page has ${itemCount} text items — above the ${PDF2WORD_MAX_ITEMS_PER_PAGE} item safety cap`);
    this.name = 'TableItemCapError';
  }
}

/** Pitch-band segmentation: same 1.8x-median rule detectTable applies
 * internally, exposed so callers can enumerate EVERY band (detectTable
 * itself returns only the first qualifying grid). */
export function splitBands(items: Item[]): Item[][] {
  const allRows = clusterRows(items);
  if (allRows.length === 0) return [];
  const pitches: number[] = [];
  for (let i = 1; i < allRows.length; i += 1) {
    pitches.push(allRows[i]!.baseline - allRows[i - 1]!.baseline);
  }
  if (pitches.length === 0) return [allRows[0]!.items];
  const sorted = [...pitches].sort((a, b) => a - b);
  const medianPitch = sorted[Math.floor(sorted.length / 2)]!;
  const breakOver = 1.8 * medianPitch;
  const bandsItems: Item[][] = [];
  let band: Item[] = [...allRows[0]!.items];
  for (let i = 1; i < allRows.length; i += 1) {
    if (pitches[i - 1]! > breakOver) {
      bandsItems.push(band);
      band = [];
    }
    band.push(...allRows[i]!.items);
  }
  bandsItems.push(band);
  return bandsItems;
}

function bboxOf(items: Item[]): TableRegion['bbox'] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const f of items) {
    if (f.x0 < x0) x0 = f.x0;
    if (f.x1 > x1) x1 = f.x1;
    const top = f.baseline - f.size;
    const bottom = f.baseline + f.size * 0.25;
    if (top < y0) y0 = top;
    if (bottom > y1) y1 = bottom;
  }
  return { x0, y0, x1, y1 };
}

export interface DetectPageResult {
  regions: TableRegion[];
  refused: RefusedRegion[];
}

/** Detect every independent table band on one page's visual text items.
 * Rotated-text bands are refused (reported), not approximated. */
export function detectTableRegions(rawItems: Item[], sourcePage: number): DetectPageResult {
  if (rawItems.length > PDF2WORD_MAX_ITEMS_PER_PAGE) {
    throw new TableItemCapError(rawItems.length);
  }
  const items = sanitizeItems(rawItems);
  const bands = splitBands(items);
  const regions: TableRegion[] = [];
  const refused: RefusedRegion[] = [];
  for (const band of bands) {
    const rotated = band.filter((f) => f.rotated);
    if (rotated.length > 0) {
      refused.push({
        sourcePage,
        bbox: bboxOf(band),
        warning: 'rotated',
      });
      continue;
    }
    if (band.length < 6) continue; // a grid needs rows x cols of ink
    const grid = detectTable(band);
    if (!grid) continue;
    regions.push({
      rows: grid.rows,
      bbox: bboxOf(band),
      sourcePage,
      warnings: [],
    });
  }
  return { regions, refused };
}
