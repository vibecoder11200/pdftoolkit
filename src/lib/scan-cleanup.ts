/*
 * Phase-6 scan cleanup — pure pixel transforms (plan 261112-0955).
 *
 * Node-testable: every function takes raw RGBA (ImageData-like
 * {data,width,height}) and returns new buffers. The worker pipeline
 * (rasterize -> clean -> encode -> release) calls these per page; the UI
 * preview downsamples before calling so the main thread stays responsive.
 *
 * Posture (from the phase file):
 * - Deskew search is a bounded downsample projection-profile scan; the
 *   applied deskew ALWAYS rotates the FULL-RESOLUTION raster (the small
 *   search raster is never shipped).
 * - Orientation detection is NOT here: DetectOS suggestion lives in
 *   scan-orientation.ts (RT5 decision record — suggestion + confirm,
 *   never auto-apply, 90/270 mirror disclosed).
 * - No text layer is ever carried onto cleaned rasters — output is
 *   image-only pages; "OCR after" rebuilds a fresh sandwich via the
 *   EXISTING composer.
 */

export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Deskew search bounds (degrees) and the step grid. */
export const DESKEW_RANGE_DEG = 5;
export const DESKEW_STEP_DEG = 0.5;
/** Downsampled search-raster long edge (bounded — the search never runs
 * on full resolution). */
export const DESKEW_SEARCH_LONG_EDGE = 600;

export interface DeskewVerdict {
  /** Rotation in degrees to CORRECT the skew (apply +angle). */
  angle: number;
  /** Best (highest) projection variance score found. */
  score: number;
}

function toGray(raster: Raster): Float32Array {
  const { data, width, height } = raster;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  }
  return gray;
}

/** Horizontal-projection variance for a trial rotation — sharper text
 * lines concentrate the histogram's mass on fewer bins. */
function projectionVariance(gray: Float32Array, width: number, height: number, angleDeg: number): number {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const bins = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = gray[y * width + x]!;
      if (v > 160) continue; // ink only
      const dx = x - cx;
      const dy = y - cy;
      const ty = Math.round(cy + dx * sin + dy * cos);
      if (ty < 0 || ty >= height) continue;
      bins[ty]! += 255 - v;
    }
  }
  let mean = 0;
  for (let i = 0; i < height; i += 1) mean += bins[i]!;
  mean /= height;
  let variance = 0;
  for (let i = 0; i < height; i += 1) {
    const d = bins[i]! - mean;
    variance += d * d;
  }
  return variance / height;
}

/** Bounded deskew search: downsample the raster so the long edge is
 * DESKEW_SEARCH_LONG_EDGE, sweep the angle grid, return the best angle. */
export function deskewSearch(raster: Raster): DeskewVerdict {
  const longEdge = Math.max(raster.width, raster.height);
  const scale = Math.min(1, DESKEW_SEARCH_LONG_EDGE / longEdge);
  const w = Math.max(1, Math.round(raster.width * scale));
  const h = Math.max(1, Math.round(raster.height * scale));
  const down = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(raster.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(raster.width - 1, Math.floor(x / scale));
      const s = (sy * raster.width + sx) * 4;
      const d = (y * w + x) * 4;
      down.data[d] = raster.data[s];
      down.data[d + 1] = raster.data[s + 1];
      down.data[d + 2] = raster.data[s + 2];
      down.data[d + 3] = 255;
    }
  }
  const gray = toGray(down);
  // score(0) seeds the search so ties (e.g. a blank raster) keep angle 0
  // - never invent a skew that isn't there.
  let best: DeskewVerdict = { angle: 0, score: projectionVariance(gray, w, h, 0) };
  for (let a = -DESKEW_RANGE_DEG; a <= DESKEW_RANGE_DEG; a += DESKEW_STEP_DEG) {
    if (a === 0) continue;
    const score = projectionVariance(gray, w, h, a);
    if (score > best.score) best = { angle: a, score };
  }
  return best;
}

/** Rotate RGBA around the center by angleDeg (nearest neighbor). */
export function rotateRaster(raster: Raster, angleDeg: number): Raster {
  if (angleDeg === 0) return raster;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { width, height } = raster;
  const out = new Uint8ClampedArray(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      // Inverse sampling of a FORWARD +angle content rotation (matches the
      // deskew search's scoring transform — the closure test pins this).
      const sx = Math.round(cx + dx * cos + dy * sin);
      const sy = Math.round(cy - dx * sin + dy * cos);
      const d = (y * width + x) * 4;
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
        out[d] = 255;
        out[d + 1] = 255;
        out[d + 2] = 255;
        out[d + 3] = 255;
        continue;
      }
      const s = (sy * width + sx) * 4;
      out[d] = raster.data[s]!;
      out[d + 1] = raster.data[s + 1]!;
      out[d + 2] = raster.data[s + 2]!;
      out[d + 3] = 255;
    }
  }
  return { data: out, width, height };
}

export type CleanupMode = 'none' | 'grayscale' | 'flatten' | 'threshold' | 'adaptive';

export interface CleanupSettings {
  mode: CleanupMode;
  /** -100..100. */
  brightness: number;
  /** -100..100. */
  contrast: number;
  /** 0..255 for 'threshold'. */
  threshold: number;
  /** Block size for 'adaptive' (odd, >= 15). */
  blockSize: number;
}

export const CLEANUP_DEFAULTS: CleanupSettings = {
  mode: 'none',
  brightness: 0,
  contrast: 0,
  threshold: 180,
  blockSize: 31,
};

/** Apply the enhancement chain. All modes keep alpha at 255 (JPEG has no
 * alpha — the encoder would flatten to black otherwise). */
export function applyCleanup(raster: Raster, settings: CleanupSettings): Raster {
  const { data, width, height } = raster;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const bright = settings.brightness * 2.55;
  const contrast = 1 + settings.contrast / 100;

  // Grayscale LUT + brightness/contrast in one pass
  const gray = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const g = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    gray[p] = (g - 128) * contrast + 128 + bright;
  }

  if (settings.mode === 'grayscale') {
    for (let p = 0; p < n; p += 1) {
      const g = gray[p]!;
      out[p * 4] = g;
      out[p * 4 + 1] = g;
      out[p * 4 + 2] = g;
      out[p * 4 + 3] = 255;
    }
    return { data: out, width, height };
  }

  // 'flatten' (background estimation via large-box mean), 'threshold',
  // 'adaptive' (Bradley local mean): need the integral image of gray.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[y * width + x]!;
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)]! + rowSum;
    }
  }

  const boxMean = (cx: number, cy: number, half: number): number => {
    const x0 = Math.max(0, cx - half);
    const y0 = Math.max(0, cy - half);
    const x1 = Math.min(width - 1, cx + half);
    const y1 = Math.min(height - 1, cy + half);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const sum =
      integral[(y1 + 1) * (width + 1) + (x1 + 1)]! -
      integral[y0 * (width + 1) + (x1 + 1)]! -
      integral[(y1 + 1) * (width + 1) + x0]! +
      integral[y0 * (width + 1) + x0]!;
    return sum / area;
  };

  if (settings.mode === 'flatten') {
    const half = Math.max(8, Math.round(Math.min(width, height) / 8));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        const g = gray[p]! - boxMean(x, y, half) + 220;
        const v = Math.max(0, Math.min(255, g));
        out[p * 4] = v;
        out[p * 4 + 1] = v;
        out[p * 4 + 2] = v;
        out[p * 4 + 3] = 255;
      }
    }
    return { data: out, width, height };
  }

  if (settings.mode === 'threshold') {
    const t = settings.threshold;
    for (let p = 0; p < n; p += 1) {
      const v = gray[p]! < t ? 0 : 255;
      out[p * 4] = v;
      out[p * 4 + 1] = v;
      out[p * 4 + 2] = v;
      out[p * 4 + 3] = 255;
    }
    return { data: out, width, height };
  }

  if (settings.mode === 'adaptive') {
    const half = Math.max(7, Math.floor(settings.blockSize / 2));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        const mean = boxMean(x, y, half);
        const v = gray[p]! < mean - 12 ? 0 : 255;
        out[p * 4] = v;
        out[p * 4 + 1] = v;
        out[p * 4 + 2] = v;
        out[p * 4 + 3] = 255;
      }
    }
    return { data: out, width, height };
  }

  // mode 'none': brightness/contrast only, keep color
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    out[i] = (data[i]! - 128) * contrast + 128 + bright;
    out[i + 1] = (data[i + 1]! - 128) * contrast + 128 + bright;
    out[i + 2] = (data[i + 2]! - 128) * contrast + 128 + bright;
    out[i + 3] = 255;
  }
  return { data: out, width, height };
}

// ---------------------------------------------------------------------------
// Export allocation gate (plan: "max edge/pixels/total allocation gate").
// Typed refusals, never silent clamping.
// ---------------------------------------------------------------------------

export const CLEANUP_PAGE_CAP = 100;
export const CLEANUP_MAX_EDGE = 4500;
export const CLEANUP_MAX_PAGE_PIXELS = 16_000_000;
export const CLEANUP_TOTAL_PIXEL_BUDGET = 400_000_000;

export class CleanupBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupBudgetError';
  }
}

/** Throws a typed CleanupBudgetError when the export allocation exceeds
 * any gate. dpi: chosen export DPI (72..600). */
export function assertExportAllocation(
  pageCount: number,
  widthPt: number,
  heightPt: number,
  dpi: number,
): { width: number; height: number } {
  if (pageCount > CLEANUP_PAGE_CAP) {
    throw new CleanupBudgetError(`pages ${pageCount} > cap ${CLEANUP_PAGE_CAP}`);
  }
  const width = Math.round((widthPt * dpi) / 72);
  const height = Math.round((heightPt * dpi) / 72);
  if (Math.max(width, height) > CLEANUP_MAX_EDGE) {
    throw new CleanupBudgetError(`long edge ${Math.max(width, height)}px > ${CLEANUP_MAX_EDGE} at ${dpi} DPI`);
  }
  const pagePixels = width * height;
  if (pagePixels > CLEANUP_MAX_PAGE_PIXELS) {
    throw new CleanupBudgetError(`page ${pagePixels}px > ${CLEANUP_MAX_PAGE_PIXELS}px`);
  }
  const total = pagePixels * pageCount;
  if (total > CLEANUP_TOTAL_PIXEL_BUDGET) {
    throw new CleanupBudgetError(`total ${total}px > ${CLEANUP_TOTAL_PIXEL_BUDGET}px budget`);
  }
  return { width, height };
}
