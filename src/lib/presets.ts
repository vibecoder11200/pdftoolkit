/*
 * Combo presets (v0.8.1 phase 4, D3/D4): fixed multi-tool chains driven from
 * the home "Chuỗi nhanh" strip. PURE DATA — zero pdf-lib/engine imports (the
 * entry chunk stays lean; each consuming tool applies its own defaults at
 * mount). The chained FILE never lives here: it rides the existing handoff
 * (appendPendingFiles per the v0.8.0 invariant — NEVER setPendingFiles,
 * whose REPLACE semantics would clobber a parked OS-launch batch).
 */

export type PresetIntake = 'pdf-multi' | 'image' | 'pdf-single';

/**
 * Per-tool partial form defaults, keyed by tool slug. Applied ONCE at the
 * target tool's mount (useState initializer) — the user can still edit
 * before running (D4). A preset never prefills a tool it does not visit.
 */
export interface PresetStepDefaults {
  compress?: { mode?: 'vector' | 'image' | 'linearize' };
  watermark?: { text?: string };
  'page-numbers'?: { preset?: 0 | 1 | 2 | 3 };
  ocr?: { engine?: 'tesseract'; output?: 'searchable-pdf' };
  encrypt?: { mode?: 'encrypt' | 'decrypt' };
}

export interface Preset {
  slug: string;
  /** Tool slugs in execution order — each slug IS a route segment. */
  steps: string[];
  intake: PresetIntake;
  defaults: PresetStepDefaults;
}

export const PRESETS: Preset[] = [
  {
    slug: 'quick-merge-compress',
    steps: ['merge', 'compress'],
    intake: 'pdf-multi',
    defaults: {
      compress: { mode: 'vector' },
    },
  },
  {
    slug: 'scan-number',
    steps: ['img-to-pdf', 'ocr', 'page-numbers'],
    intake: 'image',
    defaults: {
      // Tesseract is the chainable engine: its run output IS the searchable
      // PDF that page-numbers consumes. The AI engines export text/markdown
      // only — the banner honestly hides the continue button without outBytes.
      ocr: { engine: 'tesseract', output: 'searchable-pdf' },
      // Preset #2 = "n/total" (index 1 in the tool's preset row).
      'page-numbers': { preset: 1 },
    },
  },
  {
    slug: 'stamp-compress',
    steps: ['watermark', 'compress'],
    intake: 'pdf-single',
    defaults: {
      // Stamp text only — never the mode: the Xoá (remove) branch of the
      // watermark tool ignores text prefill entirely.
      watermark: { text: 'BẢN LƯU' },
      compress: { mode: 'vector' },
    },
  },
  {
    slug: 'unlock-merge',
    steps: ['encrypt', 'merge'],
    // pdf-single, NOT the plan table's "PDFs (multi)": step 1 (encrypt) is a
    // single-file tool — a multi intake would park N files and silently lose
    // 2..N at its mount-take. The merge step lets the user add more files.
    intake: 'pdf-single',
    defaults: {
      encrypt: { mode: 'decrypt' },
    },
  },
];

export function getPreset(slug: string): Preset | undefined {
  return PRESETS.find((p) => p.slug === slug);
}

/** Dropzone `accept` for the strip's intake dropzone (mirrors img-to-pdf for images). */
export function intakeAccept(intake: PresetIntake): string {
  return intake === 'image'
    ? 'image/jpeg,.jpg,.jpeg,image/png,.png'
    : 'application/pdf,.pdf';
}

/** Only the pdf-multi / image intakes take every dropped file. */
export function intakeMultiple(intake: PresetIntake): boolean {
  return intake === 'pdf-multi' || intake === 'image';
}

// token-mapped
