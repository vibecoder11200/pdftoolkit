import { describe, expect, it, vi } from 'vitest';
import {
  INITIAL_OVERHEAD,
  MAX_FULL_PASSES,
  QUALITY_LADDER,
  SCALE_STEPS,
  TARGET_MIN_Q,
  bytesPerPageAt,
  correctiveRung,
  pickPlan,
  runTargetCompress,
  samplePagesFor,
  type CompressSample,
  type TargetRunDeps,
} from '../src/lib/target-compress';

/*
 * v0.13.0 phase 1 — target-size compression. The pure math (interpolation,
 * pick, corrective rung) and the orchestrated runner over FAKE deps with
 * SCRIPTED encode outputs (call order is deterministic: census → scale
 * drops → pass 1 → pass 2), so overshoot/pass-2/best-effort/refuse-bigger
 * scenarios are exact. The e2e UI wiring lives in tests/tools.e2e.spec.ts.
 */

const KB = 1024;
const MB = 1024 * KB;

function samplesAt(
  scale: number,
  pairs: { quality: number; bytesPerPage: number }[],
): CompressSample[] {
  return pairs.map((p) => ({ scale, quality: p.quality, bytesPerPage: p.bytesPerPage }));
}

describe('samplePagesFor — census pages', () => {
  it('single page dedupes to [1]', () => {
    expect(samplePagesFor(1)).toEqual([1]);
  });

  it('two pages collapse to [1] (mid rounds to first)', () => {
    expect(samplePagesFor(2)).toEqual([1]);
  });

  it('multi-page doc samples first + middle', () => {
    expect(samplePagesFor(9)).toEqual([1, 5]);
  });
});

describe('bytesPerPageAt — monotone interpolation', () => {
  const samples = samplesAt(2.0, [
    { quality: 22, bytesPerPage: 20 * KB },
    { quality: 50, bytesPerPage: 60 * KB },
    { quality: 80, bytesPerPage: 180 * KB },
  ]);

  it('clamps below the lowest rung', () => { expect(bytesPerPageAt(samples, 2.0, 10)).toBe(20 * KB); });
  it('clamps above the highest rung', () => { expect(bytesPerPageAt(samples, 2.0, 95)).toBe(180 * KB); });
  it('interpolates linearly between rungs', () => { expect(bytesPerPageAt(samples, 2.0, 36)).toBe(40 * KB); });
  it('returns null for an unmeasured scale', () => { expect(bytesPerPageAt(samples, 1.0, 50)).toBeNull(); });

  it('averages duplicate rungs from the multi-page census', () => {
    const dup = [
      ...samplesAt(2.0, [{ quality: 50, bytesPerPage: 40 * KB }]),
      ...samplesAt(2.0, [{ quality: 50, bytesPerPage: 60 * KB }]),
    ];
    expect(bytesPerPageAt(dup, 2.0, 50)).toBe(50 * KB);
  });

  it('sanitizes non-monotone measurements to non-decreasing bytes', () => {
    const noisy = samplesAt(2.0, [
      { quality: 22, bytesPerPage: 60 * KB },
      { quality: 50, bytesPerPage: 40 * KB }, // noise — must not invert the curve
      { quality: 80, bytesPerPage: 180 * KB },
    ]);
    expect(bytesPerPageAt(noisy, 2.0, 30)).toBeGreaterThanOrEqual(60 * KB);
    expect(bytesPerPageAt(noisy, 2.0, 50)).toBe(60 * KB);
  });
});

describe('pickPlan — highest fitting quality', () => {
  const samples = samplesAt(2.0, [
    { quality: 22, bytesPerPage: 20 * KB },
    { quality: 50, bytesPerPage: 60 * KB },
    { quality: 80, bytesPerPage: 180 * KB },
  ]);

  it('maxes out at q80 when even the top rung fits', () => {
    const pick = pickPlan(samples, 10, 400 * MB);
    expect(pick.fits).toBe(true);
    expect(pick.plan.quality).toBe(80);
    expect(pick.needLowerScale).toBe(false);
  });

  it('solves the interpolated quality that lands on the target', () => {
    // 8 pages, 800KB target, overhead 1 → 100KB/page budget → q = 50 + 30×(100-60)/(180-60) = 60.
    const pick = pickPlan(samples, 8, 800 * KB, 1);
    expect(pick.fits).toBe(true);
    expect(pick.plan.quality).toBeCloseTo(60, 5);
  });

  it('flags needLowerScale when even q22 misses at a non-floor scale', () => {
    const pick = pickPlan(samples, 100, 1 * MB);
    expect(pick.fits).toBe(false);
    expect(pick.plan.quality).toBe(TARGET_MIN_Q);
    expect(pick.needLowerScale).toBe(true);
  });

  it('returns the floor plan at the scale floor without needLowerScale', () => {
    const floorSamples = samplesAt(1.0, [{ quality: TARGET_MIN_Q, bytesPerPage: 30 * KB }]);
    const pick = pickPlan(floorSamples, 100, 1 * MB);
    expect(pick.fits).toBe(false);
    expect(pick.needLowerScale).toBe(false);
    expect(pick.plan.scale).toBe(1.0);
  });

  it('respects the overhead factor in the budget', () => {
    const pick = pickPlan(samples, 8, 800 * KB, 1.25);
    // budget/page = 800/8/1.25 = 80KB → still between q50 (60KB) and q80 (180KB).
    expect(pick.fits).toBe(true);
    expect(pick.plan.quality).toBeCloseTo(55, 5);
  });
});

describe('correctiveRung — measured-overshoot multi-rung jump', () => {
  const perPage = 100 * KB;

  it('jumps one rung for a mild overshoot', () => {
    // ratio = 8×100/640 = 1.25 → 1 rung.
    const r = correctiveRung(60, perPage, 8, 640 * KB);
    expect(r).not.toBeNull();
    expect(r!.quality).toBe(50);
  });

  it('jumps two rungs for a 2x overshoot', () => {
    // ratio = 8×100/320 = 2.5 → > 1.6 → jump 2.
    const r = correctiveRung(60, perPage, 8, 320 * KB);
    expect(r!.quality).toBe(TARGET_MIN_Q);
  });

  it('jumps straight to the floor for a huge overshoot', () => {
    const r = correctiveRung(80, perPage, 8, 250 * KB); // ratio 3.2
    expect(r!.quality).toBe(TARGET_MIN_Q);
  });

  it('returns null when already at the floor rung', () => {
    expect(correctiveRung(TARGET_MIN_Q, perPage, 8, 640 * KB)).toBeNull();
  });

  it('never returns a quality above the current one', () => {
    const r = correctiveRung(23, perPage, 8, 640 * KB);
    expect(r).not.toBeNull();
    expect(r!.quality).toBeLessThan(23);
  });
});

describe('runTargetCompress — runner over scripted fake deps', () => {
  /**
   * Every encode call consumes the next script entry; call order is fixed:
   * census (2 pages × [80,50,22]) → optional scale-drop censuses (1 page ×
   * [50,22] each) → pass 1 (N encodes) → optional pass 2 (N encodes).
   * rebuild = scripted bytes + 800 bytes of PDF overhead.
   */
  function scriptedDeps(script: number[]) {
    let call = 0;
    return {
      deps: {
        renderImage: vi.fn(async (_page: number, scale: number) => ({
          data: new Uint8ClampedArray(4),
          width: Math.round(595 * scale),
          height: Math.round(842 * scale),
        })) as unknown as Promise<ImageData>,
        encodeJpeg: vi.fn(async () => new Uint8Array(script[call++] ?? 1000)),
        rebuild: vi.fn(async (jpegs: Uint8Array[]) =>
          new Uint8Array(jpegs.reduce((a, b) => a + b.byteLength, 0) + 800),
        ),
      } as unknown as TargetRunDeps,
      calls: () => call,
    };
  }

  const K = (n: number) => n * KB;

  it('meets the target on pass 1 and reports met', async () => {
    const { deps } = scriptedDeps([
      K(500), K(300), K(100), K(500), K(300), K(100), // census @2.0 (page-major)
      K(400), K(400), K(400), K(400), // pass 1 → 1600.8KB ≤ 2MB → met
    ]);
    const r = await runTargetCompress(8 * MB, 4, 2 * MB, deps);
    expect(r.verdict).toBe('met');
    expect(r.bytes).not.toBeNull();
    expect(r.outSize).toBeLessThanOrEqual(2 * MB);
    expect(r.passesUsed).toBe(1);
    expect(r.sampleEncodes).toBe(6);
  });

  it('runs the corrective pass 2 when pass 1 overshoots, then meets', async () => {
    // Census → q≈50; pass 1 (scripted 400KB/page → 1.6MB) overshoots 1.3×
    // → corrective jump 1 rung → q22 pass 2 lands at 600.8KB ≤ target.
    const { deps } = scriptedDeps([
      K(500), K(300), K(100), K(500), K(300), K(100), // census @2.0 (page-major)
      K(400), K(400), K(400), K(400), // pass 1 → overshoot
      K(150), K(150), K(150), K(150), // pass 2 @ q22 → fits
    ]);
    const r = await runTargetCompress(8 * MB, 4, 1.2 * MB, deps);
    expect(r.passesUsed).toBe(2);
    expect(r.verdict).toBe('met');
    expect(r.quality).toBe(TARGET_MIN_Q);
  });

  it('reports best-effort (deliverable) when two passes still miss but shrink', async () => {
    const { deps } = scriptedDeps([
      K(500), K(300), K(100), K(500), K(300), K(100), // census @2.0 (page-major) — budget < bMin
      K(40), K(20), // census @1.5 — fits by estimate → q≈28
      K(45), K(45), K(45), K(45), // pass 1 overshoots (180.8KB > 100KB)
      K(30), K(30), K(30), K(30), // pass 2 @ q22 still 120.8KB > 100KB → best-effort
    ]);
    const r = await runTargetCompress(20 * MB, 4, 100 * KB, deps);
    expect(r.verdict).toBe('best-effort');
    expect(r.bytes).not.toBeNull();
    expect(r.outSize).toBeGreaterThan(100 * KB);
    expect(r.outSize).toBeLessThan(20 * MB);
    expect(r.passesUsed).toBeLessThanOrEqual(MAX_FULL_PASSES);
    expect(r.sampleEncodes).toBe(8);
  });

  it('refuses with NO bytes when the floor config grows the file past the input', async () => {
    // 50KB vector input; 100KB target < q22 census floor @2.0 → walk to
    // 1.5, q80-clamped choice; passes land > target AND > input.
    const { deps } = scriptedDeps([
      K(500), K(300), K(100), // census @2.0 (1 page)
      K(50), K(25), // census @1.5 — budget 97.5KB ≥ bMax 50KB → top measured rung q50
      K(600), // pass 1 → 600.8KB > 100KB target
      K(700), // pass 2 @ q22 → 700.8KB > target AND > 50KB input → refuse
    ]);
    const r = await runTargetCompress(50 * KB, 1, 100 * KB, deps);
    expect(r.verdict).toBe('refuse-bigger');
    expect(r.bytes).toBeNull();
    expect(r.outSize).toBeGreaterThan(50 * KB);
    expect(r.sampleEncodes).toBe(5);
  });

  it('never exceeds the sample-encode budget across the full scale ladder', async () => {
    // Nothing ever fits → 6 + 2 + 2 = 10 census encodes, then a fitting pass 1.
    const { deps } = scriptedDeps([
      K(400), K(400), K(400), K(400), K(400), K(400), // census @2.0
      K(400), K(400), // census @1.5
      K(400), K(400), // census @1.0 (floor → min config)
      K(10), K(10), K(10), // pass 1 → 30.8KB ≤ 300KB → met
    ]);
    const r = await runTargetCompress(8 * MB, 3, 300 * KB, deps);
    expect(r.sampleEncodes).toBe(10);
    expect(r.verdict).toBe('met');
  });

  it('rejects targets below the 100KB floor', async () => {
    const { deps } = scriptedDeps([]);
    await expect(runTargetCompress(8 * MB, 1, 50 * KB, deps)).rejects.toThrow(/100KB/);
  });

  it('enforces the full-pass cap (≤ 2) by construction', async () => {
    // 4 pages, 800KB target: census (2 pages) → q≈35; pass 1 (4×500KB)
    // overshoots 2.4× → corrective jump → q22 pass 2 (600.8KB) ≤ target.
    const { deps } = scriptedDeps([
      K(500), K(300), K(100), K(500), K(300), K(100), // census @2.0 (2 pages, page-major)
      K(500), K(500), K(500), K(500), // pass 1 → 2000.8KB > 800KB target
      K(150), K(150), K(150), K(150), // pass 2 @ q22 → 600.8KB ≤ target → met
    ]);
    const r = await runTargetCompress(9 * MB, 4, 800 * KB, deps);
    expect(r.passesUsed).toBe(2);
    expect(r.verdict).toBe('met');
    expect(r.quality).toBe(TARGET_MIN_Q);
  });
  it('review: a LARGER corrective pass never replaces a smaller pass-1 result', async () => {
    // Census @2.0 → pick q≈78; pass 1 (4×550KB → 2,253,600B) overshoots
    // 2MB → corrective 1-rung jump; pass 2 scripted LARGER (4×600KB) —
    // encoder non-monotonicity. The result must stay pass 1's bytes at
    // pass 1's quality (passesUsed back to 1), never the larger pass 2.
    const { deps } = scriptedDeps([
      K(500), K(300), K(100), K(500), K(300), K(100), // census @2.0
      K(550), K(550), K(550), K(550), // pass 1 → 2,253,600B > 2MB
      K(600), K(600), K(600), K(600), // pass 2 → LARGER (2,458,960B)
    ]);
    const r = await runTargetCompress(8 * MB, 4, 2 * MB, deps);
    expect(r.verdict).toBe('best-effort'); // pass-1 bytes ≤ input, > target
    expect(r.passesUsed).toBe(1); // the larger pass 2 was DISCARDED
    expect(r.outSize).toBe(4 * 550 * 1024 + 800); // exactly pass 1's bytes
  });
});


describe('constants — ladder invariants', () => {
  it('ladder head is the max quality and floor is TARGET_MIN_Q', () => {
    expect(QUALITY_LADDER[0]).toBe(80);
    expect(QUALITY_LADDER[QUALITY_LADDER.length - 1]).toBe(TARGET_MIN_Q);
  });

  it('scale floor is 1.0 and overhead starts at 1.05', () => {
    expect(SCALE_STEPS[SCALE_STEPS.length - 1]).toBe(1.0);
    expect(INITIAL_OVERHEAD).toBeCloseTo(1.05, 5);
  });
});


describe('review regressions (2026-11-21)', () => {
  it('pickPlan NEVER selects an unmeasured rung — q80 at a [50,22]-only scale is refused', () => {
    // bytesPerPageAt CLAMPS out-of-range qualities (an 80 query over
    // [50,22] samples returns the q50 bytes, never null), so the old
    // bytesPerPageAt(...) == null guard was dead code and a generous
    // budget picked quality 80 — an encode with zero measured bytes.
    const s = samplesAt(1.5, [
      { quality: 22, bytesPerPage: 25 * KB },
      { quality: 50, bytesPerPage: 50 * KB },
    ]);
    const pick = pickPlan(s, 4, 10 * MB); // generous budget
    expect(pick.fits).toBe(true);
    expect(pick.plan.quality).toBe(50); // top MEASURED rung, not 80
  });
});
