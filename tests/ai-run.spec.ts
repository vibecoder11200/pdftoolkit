import { describe, expect, it, vi } from 'vitest';
import {
  downloadIfNeeded,
  runAiPages,
  type AiPageResult,
  type AiRunClient,
} from '../src/lib/ai-run';
import type { RasterImageData } from '../src/workers/pdf.worker';
import type { BenchmarkStore } from '../src/lib/capability';
import type { DownloadProgress } from '../src/lib/ai-models';

/*
 * Phase 4a orchestrator units: lazy page rendering (never hold N rasters),
 * page-boundary cancel keeping results, crash → onCrash(failedPage), and
 * benchmark-on-second-page (T5: first real page = warmup).
 */

function fakeClient(
  opts: { crashAt?: number; device?: 'webgpu' | 'wasm' | 'mock' } = {},
): {
  client: AiRunClient;
  ocrCalls: number[];
} {
  const ocrCalls: number[] = [];
  const client: AiRunClient = {
    ensureLoaded: vi.fn(async () => ({
      loadMs: 1,
      device: opts.device ?? ('webgpu' as const),
      adapterFingerprint: opts.device === 'wasm' ? null : 'intel|gen-12lp|iris-xe',
    })),
    downloadModel: vi.fn(async (_m: string, onProgress?: (p: DownloadProgress) => void) => {
      onProgress?.({ phase: 'downloading', percent: 50 });
      return { bytes: 10, downloaded: 10 };
    }),
    cancelDownload: vi.fn(async () => undefined),
    ocrPage: vi.fn(async (image, _onToken, o) => {
      void image;
      void o;
      const page = ocrCalls.length + 1;
      ocrCalls.push(page);
      if (opts.crashAt === page) throw new Error('AI worker crashed — it has been restarted.');
      return {
        text: `page-${page}`,
        ms: 10,
        genTokens: 5,
        tokPerSec: 16,
        firstTokenMs: page === 1 ? 9000 : 500,
      };
    }),
    isCached: vi.fn(async () => true),
    getDownloadInfo: vi.fn(async () => ({ cached: true, filesCached: 1, filesTotal: 1, totalBytes: 10 })),
    clearCache: vi.fn(async () => 0),
  };
  return { client, ocrCalls };
}

function fakeStore() {
  const saved: unknown[] = [];
  const store: BenchmarkStore = {
    loadAll: vi.fn(async () => ({})),
    save: vi.fn(async (rec) => void saved.push(rec)),
  };
  return { store, saved };
}

const raster = (): RasterImageData => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });

describe('downloadIfNeeded', () => {
  it('skips download when cached; downloads (with progress) when not', async () => {
    const a = fakeClient();
    await downloadIfNeeded(a.client, 'glm-ocr');
    expect(a.client.downloadModel).not.toHaveBeenCalled();

    const b = fakeClient();
    (b.client.isCached as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const events: number[] = [];
    await downloadIfNeeded(b.client, 'glm-ocr', (p) => events.push(p.percent ?? -1));
    expect(b.client.downloadModel).toHaveBeenCalledTimes(1);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('runAiPages', () => {
  it('runs all pages with lazy one-at-a-time rendering and page-indexed results', async () => {
    const { client, ocrCalls } = fakeClient();
    const rendered: number[] = [];
    const onPage: Array<[number, number]> = [];
    const out = await runAiPages(
      client,
      3,
      async (page) => {
        rendered.push(page);
        return raster();
      },
      { onPage: (c, t) => onPage.push([c, t]) },
    );
    expect(out.completedAll).toBe(true);
    expect(out.results.map((r: AiPageResult) => [r.page, r.text])).toEqual([
      [1, 'page-1'],
      [2, 'page-2'],
      [3, 'page-3'],
    ]);
    expect(rendered).toEqual([1, 2, 3]);
    expect(ocrCalls).toEqual([1, 2, 3]);
    expect(onPage).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('cancel stops at the page boundary and KEEPS the completed results', async () => {
    const { client } = fakeClient();
    let after = 0;
    const out = await runAiPages(
      client,
      4,
      async () => raster(),
      {},
      {
        shouldContinue: () => ++after <= 2, // pages 1-2 run, page 3 refused
      },
    );
    expect(out.completedAll).toBe(false);
    expect(out.results.map((r) => r.page)).toEqual([1, 2]);
  });

  it('worker crash on page N → onCrash(N) + throw (resume = rerun from N)', async () => {
    const { client } = fakeClient({ crashAt: 2 });
    const crashed: number[] = [];
    await expect(
      runAiPages(
        client,
        3,
        async () => raster(),
        { onCrash: (p) => crashed.push(p) },
      ),
    ).rejects.toThrow(/crashed/);
    expect(crashed).toEqual([2]);
  });

  it('benchmark-on-first-use: second completed page saves a measured record + fires onTierAfter', async () => {
    const { client } = fakeClient();
    const { store, saved } = fakeStore();
    const tiers: unknown[] = [];
    await runAiPages(
      client,
      3,
      async () => raster(),
      { onTierAfter: (tier) => tiers.push(tier) },
      { benchmarkStore: store },
    );
    expect(saved).toHaveLength(1);
    expect(tiers).toHaveLength(1);
  });

  it('fresh benchmark already stored → no re-measure', async () => {
    const { client } = fakeClient();
    const { store, saved } = fakeStore();
    // H4/A7 record identity: the orchestrator keys on the ENGINE-reported
    // fingerprint (LoadResult.adapterFingerprint) — the fake client reports
    // 'intel|gen-12lp|iris-xe'; a record with THAT fingerprint reads fresh.
    const fingerprint = 'intel|gen-12lp|iris-xe';
    (store.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      'glm-ocr': {
        [fingerprint]: {
          modelId: 'glm-ocr',
          tokPerSecWarm: 16,
          firstTokenColdMs: 9000,
          condition: 'webgpu',
          measuredAt: Date.now(),
          adapterFingerprint: fingerprint,
        },
      },
    });
    await runAiPages(client, 3, async () => raster(), {}, { benchmarkStore: store });
    expect(saved).toHaveLength(0);
  });

  it('wasm degrade run records condition wasm — WASM throughput is never labeled webgpu', async () => {
    const { client } = fakeClient({ device: 'wasm' });
    const { store, saved } = fakeStore();
    await runAiPages(client, 3, async () => raster(), {}, { benchmarkStore: store });
    expect(saved).toHaveLength(1);
    expect((saved[0] as { condition: string }).condition).toBe('wasm');
  });

  it('stored record matches the loaded device condition → no re-measure (parity)', async () => {
    const { client } = fakeClient({ device: 'wasm' });
    const { store, saved } = fakeStore();
    // wasm load → LoadResult.adapterFingerprint is null → probe fallback
    // ('?|?|?' in node); the stored record sits at THAT key with the same
    // fingerprint and the matching condition.
    const { adapterFingerprint } = await import('../src/lib/capability');
    const fp = adapterFingerprint(null);
    (store.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      'glm-ocr': {
        [fp]: {
          modelId: 'glm-ocr',
          tokPerSecWarm: 3,
          firstTokenColdMs: null,
          condition: 'wasm',
          measuredAt: Date.now(),
          adapterFingerprint: fp,
        },
      },
    });
    await runAiPages(client, 3, async () => raster(), {}, { benchmarkStore: store });
    expect(saved).toHaveLength(0);
  });

  it('stored wasm record + webgpu load → re-measures (condition mismatch counts as stale)', async () => {
    const { client } = fakeClient();
    const { store, saved } = fakeStore();
    const { adapterFingerprint } = await import('../src/lib/capability');
    const fp = adapterFingerprint(null);
    (store.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      'glm-ocr': {
        [fp]: {
          modelId: 'glm-ocr',
          tokPerSecWarm: 3,
          firstTokenColdMs: null,
          condition: 'wasm',
          measuredAt: Date.now(),
          adapterFingerprint: fp,
        },
      },
    });
    await runAiPages(client, 3, async () => raster(), {}, { benchmarkStore: store });
    expect(saved).toHaveLength(1);
    expect((saved[0] as { condition: string }).condition).toBe('webgpu');
  });

  it('resume: startPage continues numbering and keeps caller-provided context', async () => {
    const { client, ocrCalls } = fakeClient();
    const out = await runAiPages(
      client,
      3,
      async () => raster(),
      {},
      { startPage: 2 },
    );
    expect(ocrCalls).toEqual([1, 2]); // client saw renders for pages 2..3
    expect(out.results.map((r) => r.page)).toEqual([2, 3]);
    expect(out.completedAll).toBe(true);
  });
});

describe('runAiPages page selection (v0.7.0 phase 5)', () => {
  it('runs only the selected pages in order; onPage is the 1-based queue position', async () => {
    const { client, ocrCalls } = fakeClient();
    const onPage = vi.fn();
    const rendered: number[] = [];
    const { results, completedAll } = await runAiPages(client, 5, async (page) => {
      rendered.push(page);
      return raster();
    }, { onPage }, { pages: [4, 1, 3] });
    expect(completedAll).toBe(true);
    expect(results.map((r) => r.page)).toEqual([1, 3, 4]); // sorted, order preserved
    expect(ocrCalls).toEqual([1, 2, 3]); // one render per selected page
    expect(rendered).toEqual([1, 3, 4]); // the RIGHT pages rendered, in order
    // Numerator and denominator are the same unit: 1..N of the selection,
    // never the absolute page (page 5 of a 3-page selection would show 5/3).
    expect(onPage).toHaveBeenNthCalledWith(1, 1, 3);
    expect(onPage).toHaveBeenNthCalledWith(2, 2, 3);
    expect(onPage).toHaveBeenNthCalledWith(3, 3, 3);
  });

  it('selection + resume: startPage filters the selection to the remaining pages', async () => {
    const { client } = fakeClient();
    const { results } = await runAiPages(client, 5, async () => raster(), {}, { pages: [1, 3, 5], startPage: 3 });
    expect(results.map((r) => r.page)).toEqual([3, 5]);
  });

  it('empty selection: honest no-op (no renders, no onPage, completedAll)', async () => {
    const { client, ocrCalls } = fakeClient();
    const onPage = vi.fn();
    const { results, completedAll } = await runAiPages(client, 5, async () => raster(), { onPage }, { pages: [] });
    expect(results).toEqual([]);
    expect(completedAll).toBe(true);
    expect(ocrCalls).toEqual([]);
    expect(onPage).not.toHaveBeenCalled();
  });

  it('1-page selection after a 1-page resume (completedBefore) still records the benchmark, once', async () => {
    const { client } = fakeClient();
    const { store, saved } = fakeStore();
    const onTierAfter = vi.fn();
    await runAiPages(client, 5, async () => raster(), { onTierAfter }, {
      pages: [2],
      completedBefore: 1,
      benchmarkStore: store,
    });
    expect(saved.length).toBe(1);
    expect(onTierAfter).toHaveBeenCalledTimes(1);
  });
});
