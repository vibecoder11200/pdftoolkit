/*
 * Phase-6 visual diff (plan 261112-0955): raster-level change regions
 * for the compare tool's VISUAL mode. Pure + node-testable: ImageData-like
 * buffers in, change mask + connected regions + heatmap out.
 *
 * Posture (phase file step 3): "Pixel difference is not semantic/security
 * equivalence" — the visual mode surfaces RENDERING differences. The UI
 * must NOT label visually identical documents as security-passed; the
 * disclosure lives verbatim in the tool UI.
 *
 * Bounds: the diff runs on rasters pre-scaled by the caller (long edge
 * cap); regions cap at VISUAL_DIFF_MAX_REGIONS with an overflow flag —
 * an overflow is REPORTED, never silent.
 */

export interface DiffRaster {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface ChangeRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Changed-pixel count inside the region. */
  ink: number;
}

export interface VisualDiffResult {
  regions: ChangeRegion[];
  /** Changed-pixel ratio (0..1) of the whole pair. */
  changedRatio: number;
  /** True when regions were capped (overflow reported, never silent). */
  overflow: boolean;
}

/** Regions cap - overflow sets the overflow flag (honest, never silent). */
export const VISUAL_DIFF_MAX_REGIONS = 200;
/** Noise tolerance: per-channel delta at or below this is NOT a change. */
export const VISUAL_DIFF_NOISE_TOLERANCE = 8;

/** Per-pixel change mask under the noise tolerance (any-channel rule). */
export function changedMask(
  a: DiffRaster,
  b: DiffRaster,
  tolerance: number = VISUAL_DIFF_NOISE_TOLERANCE,
): Uint8Array {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('visual diff: raster sizes must match');
  }
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const dr = Math.abs((a.data[i]! ?? 255) - (b.data[i]! ?? 255));
    const dg = Math.abs((a.data[i + 1]! ?? 255) - (b.data[i + 1]! ?? 255));
    const db = Math.abs((a.data[i + 2]! ?? 255) - (b.data[i + 2]! ?? 255));
    const da = Math.abs((a.data[i + 3]! ?? 255) - (b.data[i + 3]! ?? 255));
    const delta = Math.max(dr, dg, db, da);
    mask[p] = delta > tolerance ? 1 : 0;
  }
  return mask;
}

/** Connected changed regions (8-neighborhood flood fill, iterative stack). */
export function findRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  maxRegions: number = VISUAL_DIFF_MAX_REGIONS,
): { regions: ChangeRegion[]; overflow: boolean } {
  const n = width * height;
  const visited = new Uint8Array(n);
  const regions: ChangeRegion[] = [];
  let overflow = false;
  const stack: number[] = [];
  for (let start = 0; start < n; start += 1) {
    if (mask[start] === 0 || visited[start]) continue;
    if (regions.length >= maxRegions) {
      overflow = true;
      break;
    }
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let ink = 0;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      ink += 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] === 1 && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }
    regions.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, ink });
  }
  return { regions, overflow };
}

/** Full pipeline: mask -> regions -> changed ratio. */
export function visualDiff(
  a: DiffRaster,
  b: DiffRaster,
  tolerance: number = VISUAL_DIFF_NOISE_TOLERANCE,
): VisualDiffResult {
  const mask = changedMask(a, b, tolerance);
  const n = a.width * a.height;
  let changed = 0;
  for (let p = 0; p < n; p += 1) changed += mask[p]!;
  const { regions, overflow } = findRegions(mask, a.width, a.height);
  return { regions, changedRatio: changed / n, overflow };
}

/** Paint a change heatmap onto the BASE raster (mutates a copy's pixels):
 * changed pixels tint red at 55% over the B raster. Returns a new RGBA
 * buffer so the caller can putImageData it. */
export function heatmap(b: DiffRaster, mask: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const r0 = b.data[i]!;
    const g0 = b.data[i + 1]!;
    const b0 = b.data[i + 2]!;
    if (mask[p] === 1) {
      out[i] = Math.round(r0 * 0.45 + 255 * 0.55);
      out[i + 1] = Math.round(g0 * 0.45);
      out[i + 2] = Math.round(b0 * 0.45);
      out[i + 3] = 255;
    } else {
      out[i] = r0;
      out[i + 1] = g0;
      out[i + 2] = b0;
      out[i + 3] = 255;
    }
  }
  return out;
}
