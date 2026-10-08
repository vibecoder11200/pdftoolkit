import { describe, expect, it, vi } from 'vitest';
import { AI_MOCK_NAME, MockEngine, RealEngine } from '../src/workers/ai-ocr.worker';
import type { RasterImageData } from '../src/workers/pdf.worker';

/*
 * Phase 2b/4b contract spec (F8): the mock seam must expose the SAME
 * comlink API shape as the real engine — CI e2e drives the mock through the
 * `?ai-mock=1` query flag inside the REAL worker chunk, so a shape drift
 * would only surface at runtime unless pinned here. The zero-network fence
 * is asserted at unit level too (mock never touches fetch).
 */

const MOCK_RUN_SHAPE = ['text', 'ms', 'genTokens', 'tokPerSec', 'firstTokenMs'] as const;

describe('AI engine contract (F8 mock seam)', () => {
  it('exposes the identical method set on both engines', () => {
    const mock = new MockEngine() as unknown as Record<string, unknown>;
    const real = new RealEngine() as unknown as Record<string, unknown>;
    // the mock implements the full EngineLike surface; the real engine's
    // public surface is a superset whose EngineLike members all exist.
    for (const m of ['stats', 'load', 'download', 'cancelDownload', 'run', 'dispose', 'downloadInfo', 'isCached', 'clearCache']) {
      expect(mock[m], `mock.${m}`).toBeDefined();
      expect(real[m], `real.${m}`).toBeDefined();
    }
    expect(typeof mock.load).toBe('function');
    expect(typeof real.load).toBe('function');
    expect(mock.stats).toMatchObject({ modelId: 'mock', device: 'mock', busy: false });
  });

  it('mock flags and name seam constant (F8 — rides the worker `name`)', () => {
    expect(AI_MOCK_NAME).toBe('ai-mock');
  });

  it('mock run returns canned markdown (table + heading) with the full result shape', async () => {
    const mock = new MockEngine();
    const tokens: string[] = [];
    const image: RasterImageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    const result = await mock.run(image, (chunk) => tokens.push(chunk));
    for (const key of MOCK_RUN_SHAPE) expect(key in result).toBe(true);
    expect(result.text).toContain('# BÁO CÁO TỒN KHO QUÝ 3/2026');
    expect(result.text).toContain('| Mã hàng | Thành tiền (VND) |');
    expect(result.text).toContain('| BT-031 | 12.450.000 |');
    expect(result.text).toContain('## Khu vực phía Nam');
    expect(tokens.join('')).toBe(result.text.split('\n').map((l) => `${l}\n`).join(''));
  });

  it('ZERO-NETWORK fence: mock load + run never call fetch (unconditional, F8)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('mock must be zero-network');
    });
    try {
      const mock = new MockEngine();
      const events: unknown[] = [];
      await mock.load((p) => events.push(p));
      const image: RasterImageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
      await mock.run(image, () => undefined);
      expect(events.length).toBeGreaterThanOrEqual(10); // fake download progress streamed
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('mock cancelDownload aborts the fake load', async () => {
    const mock = new MockEngine();
    const p = mock.load(() => undefined);
    mock.cancelDownload();
    await expect(p).rejects.toThrow();
  });
});
