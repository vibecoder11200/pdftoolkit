/*
 * Custom-preset adapter (v0.13.0 phase 3): maps a schema-v2 CustomPreset
 * into the runtime "chain" shape the strip/banner/session already speak
 * (steps[{slug, options}] + intake + slug-keyed defaults). PURE — no
 * engine/React imports; the lib's validation/quarantine stays authoritative
 * (this module never writes the store).
 *
 * Builder v1 slug set: 6 addable, 5 with option editors (merge carries no
 * per-step options). organize/tables stay OUT of v1 (complex state models —
 * recorded follow-up); v1 forbids REPEATING a slug in one chain because the
 * runtime prefill is slug-keyed (see preset-session).
 */

import type { CustomPreset } from './personal-presets';
import { listPresets } from './personal-presets';
import { getPreset, type Preset, type PresetIntake, type PresetStepDefaults } from './presets';

/** Builder v1 addable slugs — 6 (merge has no options editor). */
export const BUILDER_SLUGS = [
  'merge',
  'compress',
  'watermark',
  'page-numbers',
  'ocr',
  'encrypt',
] as const;
export type BuilderSlug = (typeof BUILDER_SLUGS)[number];

export interface ChainStep {
  slug: string;
  options: Record<string, unknown>;
}

export interface Chain {
  /** Builtin slug or 'custom:'-prefixed id — the session's stable identity. */
  id: string;
  /** Display name: locale key for builtins, user-authored for customs. */
  name: string;
  custom: boolean;
  steps: ChainStep[];
  intake: PresetIntake;
  /** Slug-keyed prefill slices (v1: slugs unique per chain). */
  defaults: PresetStepDefaults;
}

/** Builder v1 intake: first step merge → pdf-multi, else pdf-single. */
export function intakeFromSteps(steps: ChainStep[]): PresetIntake {
  return steps[0]?.slug === 'merge' ? 'pdf-multi' : 'pdf-single';
}

/** Map one step's options into the slug-keyed defaults slice (per-slug allowlist). */
function defaultsForStep(
  slug: string,
  options: Record<string, unknown>,
  defaults: PresetStepDefaults,
): void {
  switch (slug) {
    case 'compress': {
      const mode = options.mode;
      if (mode === 'vector' || mode === 'image' || mode === 'linearize') {
        defaults.compress = { ...defaults.compress, mode };
      }
      break;
    }
    case 'watermark': {
      if (typeof options.text === 'string' && options.text.length > 0) {
        defaults.watermark = { text: options.text };
      }
      break;
    }
    case 'page-numbers': {
      const preset = options.preset;
      if (preset === 0 || preset === 1 || preset === 2 || preset === 3) {
        defaults['page-numbers'] = { preset };
      }
      break;
    }
    case 'ocr': {
      const engine = options.engine;
      const output = options.output;
      defaults.ocr = {
        ...(engine === 'tesseract' ? { engine } : {}),
        ...(output === 'searchable-pdf' ? { output } : {}),
      };
      break;
    }
    case 'encrypt': {
      const mode = options.mode;
      if (mode === 'encrypt' || mode === 'decrypt') {
        defaults.encrypt = { mode };
      }
      break;
    }
    default:
      break; // merge and unknown slugs are not mapped (merge has no options; unknowns are skipped upstream)
  }
}

export function chainFromBuiltin(preset: Preset): Chain {
  return {
    id: preset.slug,
    name: preset.slug,
    custom: false,
    steps: preset.steps.map((slug) => ({ slug, options: {} })),
    intake: preset.intake,
    defaults: preset.defaults,
  };
}

export interface ChainFromCustomOutcome {
  chain: Chain | null;
  /** Slugs skipped (unknown to the runtime) — surfaced as a warning, never a crash. */
  skippedSlugs: string[];
}

export function chainFromCustom(c: CustomPreset): ChainFromCustomOutcome {
  const skippedSlugs: string[] = [];
  const steps: ChainStep[] = [];
  for (const step of c.steps) {
    if (!(BUILDER_SLUGS as readonly string[]).includes(step.operationId)) {
      skippedSlugs.push(step.operationId);
      continue;
    }
    steps.push({ slug: step.operationId, options: step.options ?? {} });
  }
  if (steps.length === 0) return { chain: null, skippedSlugs };
  const defaults: PresetStepDefaults = {};
  for (const step of steps) defaultsForStep(step.slug, step.options, defaults);
  return {
    chain: {
      id: c.id,
      name: c.name,
      custom: true,
      steps,
      intake: intakeFromSteps(steps),
      defaults,
    },
    skippedSlugs,
  };
}

/** Builtin slug first, then the custom store — one resolver for the session. */
export function resolveChain(idOrSlug: string): Chain | null {
  const builtin = getPreset(idOrSlug);
  if (builtin) return chainFromBuiltin(builtin);
  const custom = listPresets().find((p) => p.id === idOrSlug);
  if (custom) return chainFromCustom(custom).chain;
  return null;
}

// token-mapped
