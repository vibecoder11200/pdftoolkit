import { getPageTextItems } from '../engine/pdfjs';

/*
 * Content bounding box (v0.9.0 phase 7) — the auto-suggest for the crop
 * tab. Pure pixel scan (no engine surface): non-background ink bounding box
 * over a downscaled render, unioned with the text-layer extents (phase-5
 * getPageTextItems) as the cross-check where text exists. The user ALWAYS
 * confirms/adjusts the suggested box — it is never applied silently.
 */

/** Fractions of the visible page box, top-left origin. */
export interface FracBox {
  nx: number;
  nyTop: number;
  nw: number;
  nh: number;
}

/** Ink bounding box over raw RGBA pixels (top-left origin). The background
 * is assumed white (hardcoded 255); a pixel counts as ink when it differs
 * from white on ANY channel by more than `tol` (0-255). */
export function contentBboxFromPixels(
  width: number,
  height: number,
  data: Uint8ClampedArray,
  tol = 28,
): FracBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const dr = Math.abs(data[o]! - 255);
      const dg = Math.abs(data[o + 1]! - 255);
      const db = Math.abs(data[o + 2]! - 255);
      if (dr > tol || dg > tol || db > tol) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // blank page
  return {
    nx: minX / width,
    nyTop: minY / height,
    nw: (maxX - minX + 1) / width,
    nh: (maxY - minY + 1) / height,
  };
}

/** Union of two fraction boxes (may be null). */
export function unionFrac(a: FracBox | null, b: FracBox | null): FracBox | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.nx, b.nx);
  const y0 = Math.min(a.nyTop, b.nyTop);
  const x1 = Math.max(a.nx + a.nw, b.nx + b.nw);
  const y1 = Math.max(a.nyTop + a.nh, b.nyTop + b.nh);
  return { nx: x0, nyTop: y0, nw: x1 - x0, nh: y1 - y0 };
}

/** Padding around a suggested box (fraction of the page), clamped to [0,1]. */
export function padFrac(box: FracBox, pad: number): FracBox {
  const nx = Math.max(0, box.nx - pad);
  const nyTop = Math.max(0, box.nyTop - pad);
  const x1 = Math.min(1, box.nx + box.nw + pad);
  const y1 = Math.min(1, box.nyTop + box.nh + pad);
  return { nx, nyTop, nw: x1 - nx, nh: y1 - nyTop };
}

/**
 * Suggests the crop box for one page: pixel ink bbox over the canvas
 * (already rendered by the tab) UNION the text-layer extents, padded ~2%.
 * Returns null when the page is blank and carries no text.
 */
export async function suggestCropBox(
  bytes: Uint8Array,
  page: number,
  pixels: { width: number; height: number; data: Uint8ClampedArray } | null,
): Promise<FracBox | null> {
  const pixelBox = pixels
    ? contentBboxFromPixels(pixels.width, pixels.height, pixels.data)
    : null;
  let textBox: FracBox | null = null;
  try {
    const items = await getPageTextItems(bytes, page);
    const { getPageVisualSize } = await import('../engine/pdfjs');
    const { width: vw, height: vh } = await getPageVisualSize(bytes, page);
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x0 = it.transform[4] ?? 0;
      const baseline = it.transform[5] ?? 0;
      const h = it.height || Math.abs(it.transform[3]) || 10;
      const box: FracBox = {
        nx: x0 / vw,
        nyTop: 1 - (baseline + h) / vh,
        nw: it.width / vw,
        nh: (h * 1.1) / vh,
      };
      textBox = unionFrac(textBox, box);
    }
  } catch {
    /* no text layer — pixels only */
  }
  const box = unionFrac(pixelBox, textBox);
  return box ? padFrac(box, 0.02) : null;
}
