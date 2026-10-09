import { describe, expect, it } from 'vitest';
import {
  AI_TUNING_PRESETS,
  estimateAiFootprint,
} from '../src/lib/ai-preflight';

/*
 * Phase 3 preflight units (plan 261009-0836): the tight/not-tight matrix
 * over adapter record + RAM hint, the preset values (full = today's
 * SPIKE-measured defaults), and the estimate labeling. Pure functions —
 * no GPU, no DI needed.
 */

const GIB = 1024 ** 3;

describe('estimateAiFootprint matrix', () => {
  it('8GB RAM + 8GB buffer → not tight (strong machine)', () => {
    const e = estimateAiFootprint({ maxBufferSize: 8 * GIB }, 8);
    expect(e).toMatchObject({ predictedPeakGB: 4, tight: false });
    expect(['vram-limit', 'ram-hint']).toContain(e.basis);
  });

  it('8GB RAM + small buffer → tight via the vram proxy (iGPU shared memory)', () => {
    const e = estimateAiFootprint({ maxBufferSize: 2 * GIB }, 8);
    expect(e).toMatchObject({ basis: 'vram-limit', tight: true, predictedPeakGB: 4 });
  });

  it('4GB RAM → tight via the RAM hint', () => {
    const e = estimateAiFootprint({ maxBufferSize: 8 * GIB }, 4);
    expect(e).toMatchObject({ basis: 'ram-hint', tight: true });
  });

  it('below 4GB RAM is tight even with a big buffer', () => {
    expect(estimateAiFootprint({ maxBufferSize: 8 * GIB }, 2).tight).toBe(true);
  });

  it('cpu choice → RAM is the only constraint', () => {
    expect(estimateAiFootprint('cpu', 16)).toMatchObject({ basis: 'ram-hint', tight: false });
    expect(estimateAiFootprint('cpu', 2)).toMatchObject({ basis: 'ram-hint', tight: true });
  });

  it('cpu choice with no RAM hint → default basis, optimistic', () => {
    expect(estimateAiFootprint('cpu', null)).toMatchObject({ basis: 'default', tight: false });
  });

  it('adapter with unknown buffer + RAM hint → ram-hint basis', () => {
    expect(estimateAiFootprint({ maxBufferSize: null }, 8)).toMatchObject({ basis: 'ram-hint', tight: false });
    expect(estimateAiFootprint({ maxBufferSize: null }, 3)).toMatchObject({ basis: 'ram-hint', tight: true });
  });

  it('no hints at all → default basis, optimistic (never blocks)', () => {
    expect(estimateAiFootprint({ maxBufferSize: null }, null)).toMatchObject({
      basis: 'default',
      tight: false,
    });
  });

  it('the binding proxy is the smaller hint', () => {
    // 2GB buffer < 16GB RAM → vram binds
    expect(estimateAiFootprint({ maxBufferSize: 2 * GIB }, 16).basis).toBe('vram-limit');
    // 1GB buffer... vs 0.5GB RAM hint → ram binds (coarse but consistent)
    expect(estimateAiFootprint({ maxBufferSize: 1 * GIB }, 0.5).basis).toBe('ram-hint');
  });
});

describe('tuning presets (full = today’s SPIKE defaults)', () => {
  it('full keeps 1024px / 4096 tokens; reduced trades to 768px / 2048', () => {
    expect(AI_TUNING_PRESETS.full).toEqual({ maxLongEdge: 1024, maxNewTokens: 4096 });
    expect(AI_TUNING_PRESETS.reduced).toEqual({ maxLongEdge: 768, maxNewTokens: 2048 });
  });
});
