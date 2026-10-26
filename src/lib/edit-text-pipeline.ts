import { engine } from '../engine/client';
import { getPageTextItems } from '../engine/pdfjs';
import type { EditTextRun } from '../engine/pdf-lib';

/** Main-thread twin of the engine's EditTextVerifyError — declared locally so
 * this module never statically imports src/engine/pdf-lib (which would pull
 * the whole engine into the entry chunk; the engine must stay worker-only).
 * The tab matches errors by `name` across the comlink seam anyway. */
export class EditTextVerifyError extends Error {
  constructor(message = 'The edited output failed verification; nothing was delivered.') {
    super(message);
    this.name = 'EditTextVerifyError';
  }
}

/*
 * Text-edit pipeline (v0.9.0 phase 6) — the ONLY composer for the edit tab
 * (the tab never touches engine primitives, mirroring redact-pipeline).
 * One engine op (removal + white-out + re-typeset + scoped residue scan)
 * followed by the run-scoped semantic leg: the REMOVED run's items must no
 * longer extract BY RECT, and the replacement MUST extract inside the run
 * box. Finding 13: run-scoped, never page-wide — editing one of two
 * identical runs on a page is valid, and no rasterize recovery exists
 * anywhere in this path (a verify failure refuses, input untouched).
 */

export type { EditTextRun } from '../engine/pdf-lib';

export interface EditRunMark {
  id: string;
  page: number;
  /** Fractions of the visible page box (top-left origin, like the other tabs). */
  nx: number;
  nyTop: number;
  nw: number;
  nh: number;
  /** Baseline fraction measured from the TOP of the visible box. */
  nyBaselineTop: number;
  /** The run's text as extracted from the positional layer. */
  text: string;
  replacement: string;
  /** Font size (pt) of the original run (largest item). */
  fontSize: number;
}

/** Contiguous-baseline run grouping over raw positional items (finding 13:
 * pdf.js gives per-ITEM transforms; a "run" is a client-side grouping).
 * Items merge when they sit on the same baseline band (±35% of the tallest
 * item) and the horizontal gap is under 2.5× the band height. */
export function groupRuns(
  items: { str: string; transform: number[]; width: number; height: number }[],
  visualWidth: number,
  visualHeight: number,
): { nx: number; nyTop: number; nw: number; nh: number; nyBaselineTop: number; text: string; fontSize: number }[] {
  type Indexed = {
    str: string;
    x: number;
    baselineTop: number; // fraction from top
    w: number;
    h: number;
    fontSize: number;
  };
  const parsed: Indexed[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const fs = Math.abs(it.transform[3] ?? it.height) || it.height || 10;
    const baselineY = it.transform[5] ?? 0; // visual, bottom-up
    const x = it.transform[4] ?? 0;
    parsed.push({
      str: it.str,
      x,
      baselineTop: 1 - baselineY / visualHeight,
      w: it.width,
      h: it.height || fs,
      fontSize: fs,
    });
  }
  parsed.sort((a, b) => a.baselineTop - b.baselineTop || a.x - b.x);
  const runs: ReturnType<typeof groupRuns> = [];
  let cur: Indexed[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    const bandTop = Math.min(...cur.map((c) => c.baselineTop - c.h / visualHeight));
    const bandBottom = Math.max(...cur.map((c) => c.baselineTop));
    runs.push({
      nx: Math.min(...cur.map((c) => c.x)) / visualWidth,
      nyTop: bandTop,
      nw: (Math.max(...cur.map((c) => c.x + c.w)) - Math.min(...cur.map((c) => c.x))) / visualWidth,
      nh: bandBottom - bandTop,
      nyBaselineTop: cur[0]!.baselineTop,
      text: cur
        .slice()
        .sort((a, b) => a.x - b.x)
        .map((c) => c.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
      fontSize: Math.max(...cur.map((c) => c.fontSize)),
    });
    cur = [];
  };
  for (const it of parsed) {
    if (cur.length === 0) {
      cur.push(it);
      continue;
    }
    const last = cur[cur.length - 1]!;
    const bandH = Math.max(...cur.map((c) => c.h)) / visualHeight;
    const sameBand = Math.abs(it.baselineTop - last.baselineTop) <= Math.max(0.004, bandH * 0.35);
    const gap = (it.x - (last.x + last.w)) / visualWidth;
    if (sameBand && gap >= -bandH && gap <= bandH * 2.5) {
      cur.push(it);
    } else {
      flush();
      cur.push(it);
    }
  }
  flush();
  return runs;
}

function rectsOverlapAxis(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

/**
 * Runs the engine op and the run-scoped semantic leg. Throws
 * EditTextRefusedError (engine refusals — input untouched) or
 * EditTextVerifyError (semantic leg — output discarded). NEVER retries.
 */
export async function runEditTextPipeline(
  bytes: Uint8Array,
  marks: EditRunMark[],
  sizes: Map<number, { width: number; height: number }>,
  opts?: { fontTtf?: Uint8Array },
): Promise<Uint8Array> {
  if (marks.length === 0) throw new EditTextVerifyError('No edits to apply.');
  const runs: EditTextRun[] = marks.map((m) => {
    const { width: vw, height: vh } = sizes.get(m.page)!;
    return {
      page: m.page,
      rect: {
        x: m.nx * vw,
        y: (1 - m.nyTop - m.nh) * vh,
        w: m.nw * vw,
        h: m.nh * vh,
      },
      baselineY: (1 - m.nyBaselineTop) * vh,
      text: m.text,
      replacement: m.replacement,
      fontSize: m.fontSize,
    };
  });
  const out = await engine.editTextRuns(bytes, { runs }, opts?.fontTtf);

  // Run-scoped semantic leg (pdf.js, ONE extraction path — getPageTextItems).
  const byPage = new Map<number, EditRunMark[]>();
  for (const m of marks) {
    const list = byPage.get(m.page) ?? [];
    list.push(m);
    byPage.set(m.page, list);
  }
  for (const [page, pageMarks] of byPage) {
    const { width: vw, height: vh } = sizes.get(page)!;
    const items = await getPageTextItems(out.bytes, page);
    type Box = { x0: number; x1: number; top: number; bottom: number; str: string };
    const boxes: Box[] = [];
    for (const it of items) {
      if (!it.str) continue;
      const x0 = it.transform[4] ?? 0;
      const baseline = it.transform[5] ?? 0;
      const h = it.height || Math.abs(it.transform[3]) || 10;
      boxes.push({
        x0,
        x1: x0 + it.width,
        top: 1 - (baseline + h * 0.85) / vh,
        bottom: 1 - (baseline - h * 0.25) / vh,
        str: it.str,
      });
    }
    for (const m of pageMarks) {
      const rx0 = m.nx * vw;
      const rx1 = (m.nx + m.nw) * vw;
      // The band stays in FRACTIONS (the item boxes above are fractions too);
      // only the x-axis is in pt.
      const rTop = m.nyTop;
      const rBottom = m.nyTop + m.nh + 2 / vh; // 2pt slack under the band
      const inside = boxes.filter(
        (b) =>
          rectsOverlapAxis(b.x0, b.x1, rx0 - 2, rx1 + 2) &&
          rectsOverlapAxis(b.top, b.bottom, rTop, rBottom),
      );
      const joined = inside
        .map((b) => b.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();
      const old = norm(m.text);
      const rep = norm(m.replacement);
      if (rep.length > 0 && !norm(joined).includes(rep)) {
        throw new EditTextVerifyError(
          `The replacement "${rep}" did not extract on page ${page} — output discarded.`,
        );
      }
      if (rep.length === 0) {
        // Pure white-out: no item CENTER may remain inside the run rect
        // (robust against a neighbouring item's box poking in).
        const centerHit = boxes.find((b) => {
          const bx = (b.x0 + b.x1) / 2;
          const by = (b.top + b.bottom) / 2;
          return bx > rx0 && bx < rx1 && by > rTop && by < rBottom;
        });
        if (centerHit) {
          throw new EditTextVerifyError(
            `Page ${page} still extracts text inside the white-out area ("${centerHit.str}") — output discarded.`,
          );
        }
      }
      if (!rep.includes(old) && joined.includes(old)) {
        throw new EditTextVerifyError(
          `The original text still extracts on page ${page} — output discarded.`,
        );
      }
    }
  }
  return out.bytes;
}
