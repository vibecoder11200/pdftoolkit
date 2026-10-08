import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CACHE_STORE,
  AI_MODEL_ID,
  AI_MODELS,
  getModelSpec,
  hfFileUrl,
  pipelineOptions,
  sameOriginWasmPaths,
  sha256Hex,
  verifiedMarkerKey,
  ModelVerifyError,
  type AiModelSpec,
  type DownloadProgress,
} from '../src/lib/ai-models';
import {
  clearModelCache,
  ensureModelDownloaded,
  isCacheUsable,
  isModelVerified,
  type CacheLike,
  type DownloadDeps,
} from '../src/lib/ai-download';

/*
 * Phase 2a units (F1/F3/D3/D11): registry pins, same-origin wasmPaths pin,
 * and the download state machine — per-file resume on abort, quota mapping,
 * sha256-verify-the-stored-copy with the verified-once marker.
 */

describe('AI model registry (D8 + manifest pin)', () => {
  it('exposes exactly ONE model (D8 — no parallel models)', () => {
    expect(AI_MODELS).toHaveLength(1);
    expect(AI_MODELS[0].id).toBe('glm-ocr');
  });

  it('pins the commit SHA (40 hex), never a moving ref like "main"', () => {
    for (const m of AI_MODELS) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('carries both licenses from the manifest assert (F21)', () => {
    const spec = getModelSpec(AI_MODEL_ID);
    expect(['MIT', 'Apache-2.0']).toContain(spec.license);
    expect(['MIT', 'Apache-2.0']).toContain(spec.upstreamLicense);
    expect(spec.upstreamRepo).toBe('zai-org/GLM-OCR');
  });

  it('manifest files: q4f16 set + sizes sum into weights/total bytes', () => {
    const spec = getModelSpec(AI_MODEL_ID);
    const paths = spec.files.map((f) => f.path);
    expect(paths).toContain('onnx/decoder_model_merged_q4f16.onnx_data');
    expect(paths).toContain('onnx/embed_tokens_q4f16.onnx_data');
    expect(paths).toContain('onnx/vision_encoder_q4f16.onnx_data');
    expect(paths).toContain('tokenizer.json');
    expect(paths.every((p) => !p.includes('fp16') || p.includes('q4f16'))).toBe(true);
    const weights = spec.files.filter((f) => f.path.endsWith('.onnx_data')).reduce((s, f) => s + f.size, 0);
    expect(spec.weightsBytes).toBe(weights);
    // plan figure: ~652MB of q4f16 weights
    expect(spec.weightsBytes).toBeGreaterThan(600e6);
    expect(spec.totalBytes).toBeGreaterThan(spec.weightsBytes);
    for (const f of spec.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pipelineOptions is the exact canonical tuple (F15)', () => {
    const spec = getModelSpec(AI_MODEL_ID);
    expect(pipelineOptions(AI_MODEL_ID)).toEqual({
      task: 'image-text-to-text',
      modelId: spec.repo,
      revision: spec.revision,
      dtype: { embed_tokens: 'q4f16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' },
      use_external_data_format: true, // SPIKE: repo config omits q4f16 entries
    });
    expect(() => pipelineOptions('nonexistent')).toThrow();
  });

  it('wasmPaths pin: same-origin under BASE_URL, never CDN (F1)', () => {
    expect(sameOriginWasmPaths('/pdftoolkit/')).toEqual({
      mjs: '/pdftoolkit/ort/ort-wasm-simd-threaded.jsep.mjs',
      wasm: '/pdftoolkit/ort/ort-wasm-simd-threaded.jsep.wasm',
    });
    expect(sameOriginWasmPaths('/')).toEqual({
      mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs',
      wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm',
    });
    expect(sameOriginWasmPaths('/pdftoolkit')).toEqual(sameOriginWasmPaths('/pdftoolkit/'));
  });

  it('hfFileUrl matches the transformers.js cache-key format', () => {
    const spec = getModelSpec(AI_MODEL_ID);
    expect(hfFileUrl(spec, 'tokenizer.json')).toBe(
      `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/tokenizer.json`,
    );
  });

  it('verifiedMarkerKey is namespaced per revision', () => {
    const spec = getModelSpec(AI_MODEL_ID);
    expect(verifiedMarkerKey(spec.revision)).toBe(`__verified__/${spec.revision}`);
    expect(AI_CACHE_STORE).toBe('pdftoolkit-ai-v1');
  });
});

/* ---------- download state machine over injectable deps ---------- */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function makeSpec(): AiModelSpec {
  const base = getModelSpec(AI_MODEL_ID);
  const files = [
    { path: 'tiny-a.onnx_data', size: 4, sha256: sha('AAAA') },
    { path: 'tiny-b.onnx_data', size: 4, sha256: sha('BBBB') },
    { path: 'config.json', size: 2, sha256: sha('{}') },
  ];
  return { ...base, files, totalBytes: 10, weightsBytes: 8 };
}

/** Map-backed Cache fake; put stores the FULL streamed body. */
function fakeCache() {
  const entries = new Map<string, Uint8Array>();
  const store: CacheLike = {
    async match(url) {
      const bytes = entries.get(url);
      return bytes ? new Response(bytes.slice()) : undefined;
    },
    async put(url, res) {
      entries.set(url, new Uint8Array(await res.arrayBuffer()));
    },
    async delete(url) {
      return entries.delete(url);
    },
  };
  return { store, entries };
}

function fakeFetch(
  bodies: Map<string, string>,
  opts: { delayFile?: string; signalToCheck?: AbortSignal; onFile?: (path: string) => void } = {},
) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    const path = url.split('/').pop()!;
    opts.onFile?.(path);
    if (opts.delayFile === path) {
      // stream in 2 chunks with a microtask gap so abort can land mid-file
      const body = bodies.get(path) ?? '';
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(body.slice(0, 2)));
          await new Promise((r) => setTimeout(r, 10));
          if (init?.signal?.aborted) {
            controller.error(new DOMException('aborted', 'AbortError'));
            return;
          }
          controller.enqueue(enc.encode(body.slice(2)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    const body = bodies.get(path);
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, { status: 200 });
  });
  return { fetchImpl, calls };
}

function makeDeps(store: CacheLike, fetchImpl: DownloadDeps['fetchImpl'], events: DownloadProgress[] = []): DownloadDeps {
  return {
    fetchImpl,
    cacheStore: store,
    storage: { persist: async () => true, estimate: async () => ({ usage: 0, quota: 1e12 }) },
    onProgress: (p: DownloadProgress) => events.push(p),
  };
}

const urlOf = (spec: AiModelSpec, path: string) => hfFileUrl(spec, path);

describe('ensureModelDownloaded', () => {
  let spec: AiModelSpec;
  beforeEach(() => {
    spec = makeSpec();
  });

  it('downloads all files, streams progress phases, verifies and writes the marker', async () => {
    const { store } = fakeCache();
    const bodies = new Map([
      ['tiny-a.onnx_data', 'AAAA'],
      ['tiny-b.onnx_data', 'BBBB'],
      ['config.json', '{}'],
    ]);
    const { fetchImpl, calls } = fakeFetch(bodies);
    const events: DownloadProgress[] = [];
    const res = await ensureModelDownloaded(spec, new AbortController().signal, makeDeps(store, fetchImpl, events));
    expect(res).toEqual({ bytes: 10, downloaded: 10 });
    expect(calls).toHaveLength(3);
    expect(await isModelVerified(spec, store)).toBe(true);
    expect(events.map((e) => e.phase).filter((p, i, a) => a[i - 1] !== p)).toEqual([
      'persist',
      'preflight',
      'downloading',
      'verifying',
      'done',
    ]);
    // per-file progress carries the file name + a growing percent
    expect(events.some((e) => e.phase === 'downloading' && e.file === 'tiny-b.onnx_data' && (e.percent ?? 0) > 0)).toBe(true);
    expect(events.at(-1)?.percent).toBe(100);
  });

  it('cache-hit path: marker short-circuits — zero fetches, no re-hash (verified-once)', async () => {
    const { store } = fakeCache();
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBB'], ['config.json', '{}']]);
    const first = fakeFetch(bodies);
    await ensureModelDownloaded(spec, new AbortController().signal, makeDeps(store, first.fetchImpl));
    const second = fakeFetch(bodies);
    const res = await ensureModelDownloaded(spec, new AbortController().signal, makeDeps(store, second.fetchImpl));
    expect(second.calls).toHaveLength(0);
    expect(res.downloaded).toBe(0);
  });

  it('abort mid-file leaves NO partial entry; completed files persist → per-file resume', async () => {
    const { store } = fakeCache();
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBB'], ['config.json', '{}']]);
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch(bodies, {
      delayFile: 'tiny-b.onnx_data',
      onFile: (path) => {
        if (path === 'tiny-b.onnx_data') setTimeout(() => controller.abort(), 5);
      },
    });
    await expect(
      ensureModelDownloaded(spec, controller.signal, makeDeps(store, fetchImpl)),
    ).rejects.toThrow();
    // a is cached whole, b left no partial, marker absent
    expect((await store.match(urlOf(spec, 'tiny-a.onnx_data')))).toBeDefined();
    expect((await store.match(urlOf(spec, 'tiny-b.onnx_data')))).toBeUndefined();
    expect(await isModelVerified(spec, store)).toBe(false);

    // resume: only the missing files are fetched
    const retry = fakeFetch(bodies);
    const res = await ensureModelDownloaded(spec, new AbortController().signal, makeDeps(store, retry.fetchImpl));
    expect(retry.calls.map((u) => u.split('/').pop())).toEqual(['tiny-b.onnx_data', 'config.json']);
    expect(res.downloaded).toBe(6);
  });

  it('quota exhaustion on put maps to ModelQuotaError', async () => {
    const { store, entries } = fakeCache();
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBB'], ['config.json', '{}']]);
    const { fetchImpl } = fakeFetch(bodies);
    const origPut = store.put.bind(store);
    store.put = async (url, res) => {
      if (String(url).endsWith('tiny-b.onnx_data')) {
        entries.set(urlOf(spec, 'tiny-a.onnx_data'), new Uint8Array(0)); // a stays
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return origPut(url, res);
    };
    await expect(
      ensureModelDownloaded(spec, new AbortController().signal, makeDeps(store, fetchImpl)),
    ).rejects.toThrow(/quota/i);
  });

  it('sha256 mismatch on the STORED copy → ModelVerifyError + whole model removed (D3)', async () => {
    const { store, entries } = fakeCache();
    // fetch serves CORRUPT bytes for one file
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBX'], ['config.json', '{}']]);
    const { fetchImpl } = fakeFetch(bodies);
    await expect(
      ensureModelDownloaded(spec, new AbortController().signal, makeDeps(store, fetchImpl)),
    ).rejects.toBeInstanceOf(ModelVerifyError);
    expect(entries.size).toBe(0);
  });

  it('low-storage preflight warns but does not block (D11)', async () => {
    const { store } = fakeCache();
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBB'], ['config.json', '{}']]);
    const { fetchImpl } = fakeFetch(bodies);
    const events: DownloadProgress[] = [];
    const deps = makeDeps(store, fetchImpl, events);
    deps.storage = { persist: async () => true, estimate: async () => ({ usage: 5, quota: 11 }) }; // headroom 6 < 1.2*10
    await ensureModelDownloaded(spec, new AbortController().signal, deps);
    expect(events.some((e) => e.warning === 'low-storage')).toBe(true);
  });

  it('persist() granted flows through; throwing persist never breaks the download', async () => {
    const { store } = fakeCache();
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBB'], ['config.json', '{}']]);
    const { fetchImpl } = fakeFetch(bodies);
    const deps = makeDeps(store, fetchImpl);
    deps.storage = { persist: async () => true };
    await expect(ensureModelDownloaded(spec, new AbortController().signal, deps)).resolves.toBeTruthy();
    deps.storage = { persist: () => Promise.reject(new Error('nope')) };
    // denied/broken persist is a logged downgrade, not a failure (D11) — the
    // marker is already present, so this is the zero-fetch cache-hit path.
    await expect(ensureModelDownloaded(spec, new AbortController().signal, deps)).resolves.toEqual({
      bytes: spec.totalBytes,
      downloaded: 0,
    });
  });
});

describe('clearModelCache', () => {
  it('removes files + marker, returns deleted count', async () => {
    const { store } = fakeCache();
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBB'], ['config.json', '{}']]);
    const { fetchImpl } = fakeFetch(bodies);
    await ensureModelDownloaded(makeSpec(), new AbortController().signal, makeDeps(store, fetchImpl));
    const n = await clearModelCache(makeSpec(), store);
    expect(n).toBe(4); // 3 files + marker
    expect(await isModelVerified(makeSpec(), store)).toBe(false);
  });
});

describe('isCacheUsable (D3 verify-then-trust gate)', () => {
  it('complete AND marker-verified → usable', async () => {
    const { store } = fakeCache();
    const spec = makeSpec();
    const bodies = new Map([['tiny-a.onnx_data', 'AAAA'], ['tiny-b.onnx_data', 'BBBB'], ['config.json', '{}']]);
    const { fetchImpl } = fakeFetch(bodies);
    await ensureModelDownloaded(spec, new AbortController().signal, makeDeps(store, fetchImpl));
    await expect(isCacheUsable(spec, store, 3, 3)).resolves.toBe(true);
  });

  it('complete but NO verified marker (interrupted between last put and marker write) → NOT usable', async () => {
    const { store } = fakeCache();
    const spec = makeSpec();
    // seed all three file URLs with raw bodies — no marker, never hashed
    for (const [name, body] of [
      ['tiny-a.onnx_data', 'AAAA'],
      ['tiny-b.onnx_data', 'BBBB'],
      ['config.json', '{}'],
    ] as const) {
      await store.put(hfFileUrl(spec, name), new Response(body));
    }
    await expect(isCacheUsable(spec, store, 3, 3)).resolves.toBe(false);
  });

  it('verified marker but incomplete set → NOT usable', async () => {
    const { store } = fakeCache();
    const spec = makeSpec();
    await store.put(verifiedMarkerKey(spec.revision), new Response('ok'));
    await expect(isCacheUsable(spec, store, 2, 3)).resolves.toBe(false);
  });

  it('empty store (0/0) → NOT usable', async () => {
    const { store } = fakeCache();
    await expect(isCacheUsable(makeSpec(), store, 0, 0)).resolves.toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches node crypto reference', async () => {
    expect(await sha256Hex(new TextEncoder().encode('AAAA'))).toBe(sha('AAAA'));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
