import { describe, expect, it } from 'vitest';

import type { VisualTextItem } from '../src/engine/pdfjs';
import { detectTable } from '../src/lib/pdf2word';
import {
  detectTableRegions,
  splitBands,
  TableItemCapError,
} from '../src/lib/tables/detect';

/*
 * Phase-5 region detector tests: parity with the pdf2word detector on
 * single-band pages, multi-region enumeration, and the rotated-band
 * refusal posture (never mislocated text).
 */

const mkItem = (
  str: string,
  x0: number,
  baseline: number,
  size = 10,
  rotated = false,
): VisualTextItem => ({
  str,
  x0,
  x1: x0 + str.length * size * 0.5,
  baseline,
  size,
  fontName: 'F',
  rotated,
});

const gridItems = (
  rows: string[][],
  x0: number,
  y0: number,
  pitch = 24,
  colWidth = 80,
): VisualTextItem[] => {
  const out: VisualTextItem[] = [];
  rows.forEach((row, r) => {
    row.forEach((text, c) => {
      if (!text) return;
      out.push(mkItem(text, x0 + c * colWidth, y0 + r * pitch));
    });
  });
  return out;
};

describe('detectTableRegions — parity with the pdf2word detector', () => {
  const rows = [
    ['Item', 'Qty', 'Price'],
    ['Bolt', '4', '0.50'],
    ['Nut', '8', '0.25'],
    ['Washer', '16', '0.10'],
  ];
  it('single-band page: region rows IDENTICAL to detectTable output', () => {
    const items = gridItems(rows, 48, 700);
    const viaRegions = detectTableRegions(items, 1);
    expect(viaRegions.refused).toEqual([]);
    expect(viaRegions.regions).toHaveLength(1);
    expect(viaRegions.regions[0]!.rows).toEqual(detectTable(items)!.rows);
  });

  it('non-table page: zero regions (honest refusal, no invention)', () => {
    const items = gridItems(
      [['Single line of prose.'], ['Another line.'], ['And a third.']],
      48,
      700,
      20,
    );
    const r = detectTableRegions(items, 1);
    expect(r.regions).toEqual([]);
    expect(r.refused).toEqual([]);
  });

  it('two tables on one page: BOTH bands detected with independent bboxes', () => {
    const t1 = gridItems(
      [
        ['A1', 'A2', 'A3'],
        ['B1', 'B2', 'B3'],
        ['C1', 'C2', 'C3'],
      ],
      48,
      500,
    );
    const t2 = gridItems(
      [
        ['X1', 'X2'],
        ['Y1', 'Y2'],
        ['Z1', 'Z2'],
      ],
      48,
      650,
    );
    const r = detectTableRegions([...t1, ...t2], 3);
    expect(r.regions).toHaveLength(2);
    expect(r.regions[0]!.rows[0]).toEqual(['A1', 'A2', 'A3']);
    expect(r.regions[1]!.rows[0]).toEqual(['X1', 'X2']);
    expect(r.regions[0]!.bbox.y1).toBeLessThan(r.regions[1]!.bbox.y0 + 1);
    expect(r.regions[1]!.sourcePage).toBe(3);
  });

  it('rotated band: REFUSED with warning, never approximated into cells', () => {
    const t1 = gridItems(
      [
        ['A1', 'A2'],
        ['B1', 'B2'],
        ['C1', 'C2'],
      ],
      48,
      700,
    );
    const stamp = mkItem('ROTATED STAMP', 300, 690, 10, true);
    const r = detectTableRegions([...t1, stamp], 1);
    expect(r.regions).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]!.warning).toBe('rotated');
  });

  it('item cap: over-budget page throws the typed cap error', () => {
    const items: VisualTextItem[] = Array.from({ length: 20001 }, (_, i) =>
      mkItem('x', i % 100, 800 - (i % 500)),
    );
    expect(() => detectTableRegions(items, 1)).toThrow(TableItemCapError);
  });

  it('splitBands: 1.8x-median pitch rule splits two aligned grids', () => {
    const t1 = gridItems(
      [
        ['A', 'B'],
        ['C', 'D'],
        ['E', 'F'],
      ],
      48,
      700,
    );
    const t2 = gridItems(
      [
        ['G', 'H'],
        ['I', 'J'],
        ['K', 'L'],
      ],
      48,
      600,
    );
    const bands = splitBands([...t1, ...t2]);
    expect(bands.length).toBe(2);
  });
});
