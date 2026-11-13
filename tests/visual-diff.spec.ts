import { describe, expect, it } from 'vitest';

import {
  changedMask,
  findRegions,
  heatmap,
  visualDiff,
  VISUAL_DIFF_MAX_REGIONS,
} from '../src/lib/visual-diff';
import type { DiffRaster } from '../src/lib/visual-diff';

/*
 * Phase-6 visual diff suite: noise tolerance, connected regions, overflow
 * honesty, heatmap tint.
 */

const solid = (w: number, h: number, v: number): DiffRaster => ({
  data: new Uint8ClampedArray(w * h * 4).fill(v),
  width: w,
  height: h,
});

describe('changedMask', () => {
  it('within tolerance -> no change; above -> change (any-channel)', () => {
    const a = solid(2, 1, 200);
    const b = solid(2, 1, 200);
    let mask = changedMask(a, b);
    expect(mask[0]).toBe(0);
    b.data[0] = 205; // +5 green channel, within tolerance 8
    mask = changedMask(a, b);
    expect(mask[0]).toBe(0);
    b.data[0] = 215; // +15 -> change
    mask = changedMask(a, b);
    expect(mask[0]).toBe(1);
  });

  it('size mismatch throws (never fabricates a diff)', () => {
    expect(() => changedMask(solid(2, 1, 0), solid(2, 2, 0))).toThrow(/sizes must match/);
  });
});

describe('findRegions', () => {
  it('two separated blobs -> two regions with bboxes', () => {
    const w = 6;
    const mask = new Uint8Array(6 * 4);
    mask[1 * 6 + 1] = 1;
    mask[1 * 6 + 2] = 1;
    mask[3 * 6 + 4] = 1;
    const { regions, overflow } = findRegions(mask, w, 4);
    expect(regions).toHaveLength(2);
    expect(overflow).toBe(false);
    expect(regions[0]).toMatchObject({ x: 1, y: 1, width: 2, height: 1 });
    expect(regions[1]).toMatchObject({ x: 4, y: 3, width: 1, height: 1 });
  });

  it('overflow reports honestly (never silent)', () => {
    const w = 32;
    const h = 110;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < VISUAL_DIFF_MAX_REGIONS + 5; i += 1) {
      // deterministic grid: 4px x-gap and y-gap => guaranteed separate blobs
      mask[(2 + Math.floor(i / 8) * 4) * w + (2 + (i % 8) * 4)] = 1;
    }
    const { overflow } = findRegions(mask, w, h);
    expect(overflow).toBe(true);
  });
});

describe('visualDiff + heatmap', () => {
  it('identical rasters: zero regions, ratio 0 (noise-tolerant)', () => {
    const a = solid(10, 10, 240);
    const b = solid(10, 10, 244);
    const r = visualDiff(a, b);
    expect(r.regions).toHaveLength(0);
    expect(r.changedRatio).toBe(0);
  });

  it('one changed block: one region + heatmap tints it red', () => {
    const a = solid(8, 8, 250);
    const b = solid(8, 8, 250);
    for (let y = 2; y < 4; y += 1) {
      for (let x = 2; x < 4; x += 1) {
        const i = (y * 8 + x) * 4;
        b.data[i] = 0;
        b.data[i + 1] = 0;
        b.data[i + 2] = 0;
      }
    }
    const r = visualDiff(a, b);
    expect(r.regions).toHaveLength(1);
    expect(r.changedRatio).toBeGreaterThan(0);
    const mask = changedMask(a, b);
    const hm = heatmap(b, mask, 8, 8);
    const hit = (2 * 8 + 2) * 4;
    expect(hm[hit]).toBeGreaterThan(130); // red boost over black ink
    expect(hm[hit + 1]).toBeLessThan(60);
  });
});
