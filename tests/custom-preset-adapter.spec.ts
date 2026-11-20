import { describe, expect, it, beforeEach } from 'vitest';
import {
  BUILDER_SLUGS,
  chainFromBuiltin,
  chainFromCustom,
  intakeFromSteps,
  resolveChain,
} from '../src/lib/custom-preset-adapter';
import { newCustomPreset, savePreset, type CustomPreset, type CustomStep } from '../src/lib/personal-presets';
import { getPreset } from '../src/lib/presets';

/*
 * v0.13.0 phase 3 — custom→chain adapter: slug/defaults/intake mapping for
 * the 6 builder slugs, unknown-slug SKIP with a surfaced count (never a
 * crash), empty-after-skip refusal, and resolveChain builtin-first lookup.
 */

function customWith(steps: { slug: string; options?: Record<string, unknown> }[]): CustomPreset {
  const base = newCustomPreset('test-chain');
  const built: CustomStep[] = steps.map((s, i) => ({
    stepId: `s${i + 1}`,
    operationId: s.slug,
    operationVersion: 1,
    options: s.options ?? {},
  }));
  return { ...base, steps: built };
}

beforeEach(() => {
  // resolveChain reads the custom store — isolate each test with a fresh
  // in-memory localStorage (node has none).
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

describe('BUILDER_SLUGS — v1 set', () => {
  it('is exactly the 6 addable slugs (merge among them, no editor)', () => {
    expect([...BUILDER_SLUGS].sort()).toEqual(
      ['compress', 'encrypt', 'merge', 'ocr', 'page-numbers', 'watermark'].sort(),
    );
  });
});

describe('chainFromCustom — mapping', () => {
  it('maps slugs, options and pdf-multi intake from a merge-first chain', () => {
    const c = customWith([
      { slug: 'merge' },
      { slug: 'compress', options: { mode: 'vector' } },
    ]);
    const { chain, skippedSlugs } = chainFromCustom(c);
    expect(skippedSlugs).toEqual([]);
    expect(chain!.custom).toBe(true);
    expect(chain!.id).toBe(c.id);
    expect(chain!.name).toBe('test-chain');
    expect(chain!.steps.map((s) => s.slug)).toEqual(['merge', 'compress']);
    expect(chain!.intake).toBe('pdf-multi');
    expect(chain!.defaults).toEqual({ compress: { mode: 'vector' } });
  });

  it('infers pdf-single intake for a non-merge first step', () => {
    const c = customWith([
      { slug: 'watermark', options: { text: 'BẢN LƯU' } },
      { slug: 'ocr', options: { engine: 'tesseract', output: 'searchable-pdf' } },
    ]);
    const { chain } = chainFromCustom(c);
    expect(chain!.intake).toBe('pdf-single');
    expect(chain!.defaults).toEqual({
      watermark: { text: 'BẢN LƯU' },
      ocr: { engine: 'tesseract', output: 'searchable-pdf' },
    });
  });

  it('maps page-numbers preset and encrypt mode slices', () => {
    const c = customWith([
      { slug: 'page-numbers', options: { preset: 2 } },
      { slug: 'encrypt', options: { mode: 'decrypt' } },
    ]);
    const { chain } = chainFromCustom(c);
    expect(chain!.defaults).toEqual({
      'page-numbers': { preset: 2 },
      encrypt: { mode: 'decrypt' },
    });
  });

  it('ignores option fields outside the per-slug allowlist (no crash)', () => {
    const c = customWith([
      { slug: 'compress', options: { mode: 'hyper', evil: { a: 1 } } },
    ]);
    const { chain } = chainFromCustom(c);
    expect(chain!.defaults).toEqual({});
  });

  it('SKIPS unknown slugs with a surfaced count; empty-after-skip → null chain', () => {
    const c = customWith([{ slug: 'organize' }, { slug: 'tables' }]);
    const { chain, skippedSlugs } = chainFromCustom(c);
    expect(chain).toBeNull();
    expect(skippedSlugs).toEqual(['organize', 'tables']);
  });

  it('keeps known steps around a skipped one (honest partial chain)', () => {
    const c = customWith([{ slug: 'merge' }, { slug: 'mystery' }, { slug: 'encrypt', options: { mode: 'encrypt' } }]);
    const { chain, skippedSlugs } = chainFromCustom(c);
    expect(skippedSlugs).toEqual(['mystery']);
    expect(chain!.steps.map((s) => s.slug)).toEqual(['merge', 'encrypt']);
  });
});

describe('intakeFromSteps', () => {
  it('empty steps default to pdf-single', () => {
    expect(intakeFromSteps([])).toBe('pdf-single');
  });
});

describe('chainFromBuiltin + resolveChain', () => {
  it('builtin chains keep their identity and intake', () => {
    const p = getPreset('scan-number')!;
    const chain = chainFromBuiltin(p);
    expect(chain.custom).toBe(false);
    expect(chain.intake).toBe('image');
    expect(chain.defaults['page-numbers']).toEqual({ preset: 1 });
  });

  it('resolveChain finds builtins by slug and customs by id', () => {
    expect(resolveChain('quick-merge-compress')?.id).toBe('quick-merge-compress');
    const c = customWith([
      { slug: 'watermark', options: { text: 'X' } },
      { slug: 'compress', options: { mode: 'image' } },
    ]);
    savePreset(c);
    const resolved = resolveChain(c.id);
    expect(resolved?.custom).toBe(true);
    expect(resolved?.defaults).toEqual({ watermark: { text: 'X' }, compress: { mode: 'image' } });
    expect(resolveChain('no-such-thing')).toBeNull();
  });
});


describe('review regression (2026-11-21) — repeated slugs from imports', () => {
  it('a [compress, compress] import resolves to ONE compress step, repeat surfaced', () => {
    // The v0.12 schema stays permissive (independent options per repeated
    // op are valid STORE data), but the runtime prefill is slug-keyed —
    // the adapter must skip a repeat like an unknown slug, never resolve
    // a chain that would prefill both steps from one slice.
    const { chain, skippedSlugs } = chainFromCustom(customWith([
      { slug: 'watermark', options: { text: 'A' } },
      { slug: 'compress', options: { mode: 'vector' } },
      { slug: 'compress', options: { mode: 'image' } },
    ]));
    expect(chain).not.toBeNull();
    expect(chain!.steps.map((s) => s.slug)).toEqual(['watermark', 'compress']);
    expect(skippedSlugs).toEqual(['compress']); // the REPEAT, not the op itself
    expect(chain!.defaults.compress).toEqual({ mode: 'vector' }); // first wins
  });
});
