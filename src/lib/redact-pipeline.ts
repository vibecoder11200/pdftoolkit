import { engine, getWorker } from '../engine/client';
import type {
  RedactCensusKind,
  RedactCensusReport,
  RedactFinalizeResult,
  RedactRect,
  RedactSurgicalPage,
} from '../engine/pdf-lib';

/*
 * THE single redact composer (v0.9.0 phase 3, findings 2+5). The tool UI
 * NEVER touches engine primitives directly: census → user decisions → this
 * pipeline (raster JPEGs rendered with the marks PAINTED pre-encode →
 * redactFinalize → main-thread semantic + pixel verify legs) → verified
 * bytes. Only this wrapper's output may reach deliverBytes — the orphan
 * rule is enforced structurally by there being no second composer.
 *
 * The verify legs re-check the FINALIZED bytes with pdf.js (an independent
 * renderer), each covering the other's blind spots: the semantic leg fails
 * when any text item still intersects a surgical mark (ONE bounded retry
 * escalates the page to raster), the extraction leg fails when a rasterized
 * page still yields text, and the pixel leg fails when a painted region is
 * not uniformly covered (finding 1 — an unpainted raster ships the secret
 * as pixels).
 */

export type { RedactCensusKind, RedactCensusReport, RedactFinalizeResult, RedactRect };

/** A user-drawn mark, in fractions of the VISIBLE page box (resolution-
 * independent: drags happen at render scale, the spec uses visual points). */
export interface RedactMark {
  id: string;
  /** 1-based page number. */
  page: number;
  /** Top-left anchor, fractions of visual width/height. */
  nx: number;
  nyTop: number;
  nw: number;
  nh: number;
}

/** Normalized mark → visual-space rect (y flips: marks anchor top-left like
 * a screen, PDF visual space anchors bottom-left). */
export function markToRect(
  mark: Omit<RedactMark, 'id'>,
  visualWidth: number,
  visualHeight: number,
): RedactRect {
  return {
    x: mark.nx * visualWidth,
    y: (1 - mark.nyTop - mark.nh) * visualHeight,
    w: mark.nw * visualWidth,
    h: mark.nh * visualHeight,
  };
}

/** Keywords driving the byte-scan + doc-channel scrub needles. The engine
 * refuses an empty list (the hygiene scan has nothing to look for), so the
 * UI requires at least one. */
export function parseSecrets(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,;]+/)) {
    const s = raw.trim();
    if (s.length > 0 && !seen.has(s)) seen.add(s);
  }
  return [...seen];
}

export interface RedactRunInput {
  marks: RedactMark[];
  /** Census-flagged pages the user chose to BURN (rasterize). */
  burnPages: number[];
  /** Census-flagged pages the user chose to KEEP untouched (accepting the
   * hidden-text risk — surfaced, never silent). */
  keptFlagged: number[];
  /** 'Đốt trang an toàn' switch: every marked page rides the raster path. */
  forceRaster: boolean;
  /** Doc channels to leave untouched (census inventory, user keep-list). */
  scrubSkip: string[];
  /** Keywords for the byte-scan + scrub (non-empty — engine refuses else). */
  secrets: string[];
}

export interface RedactPlan {
  surgical: RedactSurgicalPage[];
  rasterPages: number[];
  /** Flagged pages the user keeps — untouched by the run. */
  untouchedFlagged: number[];
}

/** Pure run planner (tested in redact-tool.spec.ts): marks on a census-flagged
 * page escalate to raster (finding 7), the explicit switch forces raster,
 * marks beyond the page count are stale (mid-swap guard) and dropped. */
export function planRedaction(
  census: RedactCensusReport,
  input: RedactRunInput,
  sizeOf: (page: number) => { width: number; height: number },
): RedactPlan {
  const flagged = new Set(census.pages.map((p) => p.page));
  const kept = new Set(input.keptFlagged.filter((p) => flagged.has(p)));
  const rasterPages = new Set<number>(input.burnPages.filter((p) => flagged.has(p)));
  const marksByPage = new Map<number, RedactMark[]>();
  for (const m of input.marks) {
    if (m.page < 1 || m.page > census.pageCount || kept.has(m.page)) continue;
    const list = marksByPage.get(m.page) ?? [];
    list.push(m);
    marksByPage.set(m.page, list);
  }
  const surgical: RedactSurgicalPage[] = [];
  for (const [page, marks] of marksByPage) {
    if (rasterPages.has(page)) continue; // burn wins for the page
    if (input.forceRaster || flagged.has(page)) {
      rasterPages.add(page);
      continue;
    }
    const { width, height } = sizeOf(page);
    surgical.push({ page, rects: marks.map((m) => markToRect(m, width, height)) });
  }
  surgical.sort((a, b) => a.page - b.page);
  return {
    surgical,
    rasterPages: [...rasterPages].sort((a, b) => a - b),
    untouchedFlagged: [...kept].sort((a, b) => a - b),
  };
}

/** Raster budget (finding 11): above this many escalated pages the UI must
 * confirm before rendering (OCR-style gate). Peak-hold bounds live in the
 * matrix-redact nightly. */
export const REDACT_RASTER_BUDGET = 20;

/** Axis-aligned rect intersection with a small negative margin so items that
 * merely TOUCH a mark's edge are not flagged as residue. */
export function rectsIntersect(a: RedactRect, b: RedactRect, eps = 0.5): boolean {
  return (
    a.x + eps < b.x + b.w &&
    b.x + eps < a.x + a.w &&
    a.y + eps < b.y + b.h &&
    b.y + eps < a.y + a.h
  );
}

export type RedactPhase = 'render' | 'finalize' | 'verify';

export interface RedactRunHooks {
  onPhase?: (phase: RedactPhase, done: number, total: number) => void;
}

export interface RedactRunOutcome {
  result: RedactFinalizeResult;
  plan: RedactPlan;
  /** True when the semantic retry escalated pages to raster. */
  escalated: number[];
}

const JPEG_QUALITY = 90;

/** Renders one page to JPEG at the engine's clamped scale with the page's
 * marks PAINTED BEFORE encoding (finding 1 — an unpainted raster ships the
 * secret as pixels). */
async function renderRasterJpeg(
  bytes: Uint8Array,
  page: number,
  marks: RedactMark[],
  redactRasterScale: (w: number, h: number, dpi?: number) => number,
): Promise<Uint8Array> {
  const { renderPageToCanvas } = await import('../engine/pdfjs');
  const size = await import('../engine/pdfjs').then((m) => m.getPageVisualSize(bytes, page));
  const canvas = document.createElement('canvas');
  await renderPageToCanvas(bytes, page, canvas, redactRasterScale(size.width, size.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('redact: 2d context unavailable');
  ctx.fillStyle = '#000000';
  for (const m of marks) {
    ctx.fillRect(m.nx * canvas.width, m.nyTop * canvas.height, m.nw * canvas.width, m.nh * canvas.height);
  }
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const jpeg = await getWorker().encodeJpeg(
    { data: imageData.data, width: imageData.width, height: imageData.height },
    { quality: JPEG_QUALITY, progressive: true },
  );
  if (jpeg.byteLength === 0) throw new Error('redact: jpeg encode failed');
  return jpeg;
}

/** Pixel-uniformity check for one painted region (finding 1's runtime leg):
 * a grid of samples inside the rect must be one flat color (small JPEG
 * tolerance). Returns the worst per-channel spread. */
export function regionSpread(
  img: { data: Uint8ClampedArray; width: number; height: number },
  rect: { nx: number; nyTop: number; nw: number; nh: number },
): number {
  const inset = 0.06; // keep samples off the antialiased edge
  const x0 = Math.round((rect.nx + rect.nw * inset) * img.width);
  const x1 = Math.round((rect.nx + rect.nw * (1 - inset)) * img.width);
  const y0 = Math.round((rect.nyTop + rect.nh * inset) * img.height);
  const y1 = Math.round((rect.nyTop + rect.nh * (1 - inset)) * img.height);
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0; // degenerate — nothing to sample
  const steps = 5;
  let min = [255, 255, 255];
  let max = [0, 0, 0];
  for (let sy = 0; sy < steps; sy += 1) {
    for (let sx = 0; sx < steps; sx += 1) {
      const px = x0 + Math.round(((x1 - x0) * sx) / (steps - 1));
      const py = y0 + Math.round(((y1 - y0) * sy) / (steps - 1));
      const o = (py * img.width + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        const v = img.data[o + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
  }
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** Uniformity threshold: mozjpeg on a flat fill varies by a few units;
 * content bleed under an unpainted region blows past this fast. */
export const REDACT_PIXEL_TOLERANCE = 40;

async function semanticFailures(
  bytes: Uint8Array,
  plan: RedactPlan,
): Promise<{ surgical: number[]; raster: number[] }> {
  const { getTextItemRects } = await import('../engine/pdfjs');
  const surgical: number[] = [];
  for (const s of plan.surgical) {
    const items = await getTextItemRects(bytes, s.page);
    if (items.some((r) => s.rects.some((m) => rectsIntersect(r, m)))) surgical.push(s.page);
  }
  const raster: number[] = [];
  for (const page of plan.rasterPages) {
    if ((await getTextItemRects(bytes, page)).length > 0) raster.push(page);
  }
  return { surgical, raster };
}

/**
 * Composes ONE redact run end-to-end. Throws the engine's typed errors as-is
 * (RedactRefusedError / RedactVerifyError / RedactParseError — name-based
 * across comlink); a semantic-verify failure gets exactly ONE bounded retry
 * with the failed pages escalated to raster (finding 4), then fails closed.
 */
export async function runRedactionPipeline(
  bytes: Uint8Array,
  census: RedactCensusReport,
  input: RedactRunInput,
  hooks: RedactRunHooks = {},
): Promise<RedactRunOutcome> {
  const sizeCache = new Map<number, { width: number; height: number }>();
  const sizeOf = (page: number): { width: number; height: number } => {
    // Synchronous in the planner: sizes are pre-warmed below before planning.
    const hit = sizeCache.get(page);
    if (!hit) throw new Error(`redact: missing geometry for page ${page}`);
    return hit;
  };
  const { getPageVisualSize } = await import('../engine/pdfjs');
  const pages = new Set<number>([
    ...input.marks.map((m) => m.page),
    ...input.burnPages,
  ]);
  for (const p of pages) {
    if (p >= 1 && p <= census.pageCount && !sizeCache.has(p)) {
      sizeCache.set(p, await getPageVisualSize(bytes, p));
    }
  }
  let plan = planRedaction(census, input, sizeOf);

  const { redactRasterScale } = await import('../engine/pdf-lib');
  const marksOf = (page: number) => input.marks.filter((m) => m.page === page);

  const buildRaster = async (rasterPages: number[]) => {
    const out: { page: number; jpeg: Uint8Array }[] = [];
    for (const [i, page] of rasterPages.entries()) {
      hooks.onPhase?.('render', i, rasterPages.length);
      out.push({ page, jpeg: await renderRasterJpeg(bytes, page, marksOf(page), redactRasterScale) });
    }
    return out;
  };

  hooks.onPhase?.('finalize', 0, 1);
  let result = await engine.redactFinalize(bytes, {
    secrets: input.secrets,
    surgical: plan.surgical,
    raster: await buildRaster(plan.rasterPages),
    scrubSkip: input.scrubSkip,
  });

  hooks.onPhase?.('verify', 0, 1);
  let failed = await semanticFailures(result.bytes, plan);
  const escalated: number[] = [];
  if (failed.raster.length > 0) {
    // A rasterized page that still extracts text is an engine-contract
    // violation — no retry can fix it (the page is already an image).
    const { RedactVerifyError } = await import('../engine/pdf-lib');
    throw new RedactVerifyError(`Rasterized pages ${failed.raster.join(', ')} still extract text.`);
  }
  if (failed.surgical.length > 0) {
    // ONE bounded retry: escalate the failed pages, re-finalize from the
    // ORIGINAL bytes (never from the intermediate output).
    for (const page of failed.surgical) escalated.push(page);
    plan = {
      ...plan,
      surgical: plan.surgical.filter((s) => !failed.surgical.includes(s.page)),
      rasterPages: [...new Set([...plan.rasterPages, ...failed.surgical])].sort((a, b) => a - b),
    };
    result = await engine.redactFinalize(bytes, {
      secrets: input.secrets,
      surgical: plan.surgical,
      raster: await buildRaster(plan.rasterPages),
      scrubSkip: input.scrubSkip,
    });
    hooks.onPhase?.('verify', 1, 1);
    failed = await semanticFailures(result.bytes, plan);
    if (failed.surgical.length > 0 || failed.raster.length > 0) {
      const { RedactVerifyError } = await import('../engine/pdf-lib');
      throw new RedactVerifyError(
        `Pages ${[...failed.surgical, ...failed.raster].join(', ')} still carry text under the marks.`,
      );
    }
  }

  // Pixel leg (raster pages with marks): every painted region must be flat.
  const { renderPageToCanvas } = await import('../engine/pdfjs');
  for (const page of plan.rasterPages) {
    const marks = marksOf(page);
    if (marks.length === 0) continue;
    const canvas = document.createElement('canvas');
    const size = sizeCache.get(page) ?? (await getPageVisualSize(bytes, page));
    await renderPageToCanvas(result.bytes, page, canvas, Math.min(1.5, 1500 / Math.max(size.width, size.height)));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('redact: 2d context unavailable');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (const m of marks) {
      if (regionSpread(img, m) > REDACT_PIXEL_TOLERANCE) {
        const { RedactVerifyError } = await import('../engine/pdf-lib');
        throw new RedactVerifyError(`Page ${page} has a mark region that is not uniformly covered.`);
      }
    }
  }

  return { result, plan, escalated };
}
