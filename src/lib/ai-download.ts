/*
 * Model download + verify (v0.5.0 phase 2a, D3/D11; chunked storage from
 * the 2026-10-09 hand-test round). Runs inside the AI worker (every network
 * call — the app CSP forbids main-thread model fetches); deps are
 * injectable so vitest can drive abort/quota/mismatch paths against fakes.
 *
 * CHUNKED STORAGE: each manifest file is stored as ceil(size/64MiB) part
 * entries (`${url}::part/${i}`), reassembled on read (chunkKeys +
 * readModelFile in ai-models.ts). Chrome's Cache API in dedicated workers
 * fails whole-file puts of the 321MB decoder shard — "Unexpected internal
 * error" for a buffer body, "Cache.put() encountered a network error" for
 * a raw stream body — while ≤64MB puts are reliable (hand-test round,
 * repeated on ephemeral AND persistent profiles; the small files always
 * succeeded). Parts also give chunk-granular resume: a completed part is
 * kept and a retry only refetches the file whose parts are incomplete.
 *
 * Verify (D3): after the last part put, EVERY file is reassembled from its
 * parts and hashed — never the RAM/network buffer. A mismatch deletes the
 * whole model from the store and throws ModelVerifyError. The verified
 * marker is written once per revision: the cache-hit path skips re-hashing
 * on every use (verified-once), but any new download invalidates it.
 */
import {
  MODEL_CHUNK_BYTES,
  chunkKeys,
  hfFileUrl,
  isFileCompleteInStore,
  readModelFile,
  sha256Hex,
  verifiedMarkerKey,
  type AiModelSpec,
  type DownloadProgress,
  ModelVerifyError,
  ModelQuotaError,
} from './ai-models';

export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
  keys?(): Promise<Request[]>;
}

export interface StorageManagerLike {
  persist?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

export interface DownloadDeps {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  cacheStore: CacheLike;
  storage?: StorageManagerLike;
  onProgress?: (p: DownloadProgress) => void;
}

const HEADROOM_FACTOR = 1.2;

/** Ask for persistent storage — best effort, never throws (D11). */
export async function requestPersistence(deps: DownloadDeps): Promise<boolean> {
  try {
    return (await deps.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** D11 pre-flight: warn (never block) when headroom < 1.2× model size. */
export async function preflightStorage(
  spec: AiModelSpec,
  deps: DownloadDeps,
): Promise<'ok' | 'low-storage'> {
  try {
    const est = await deps.storage?.estimate?.();
    if (!est?.quota) return 'ok';
    const headroom = (est.quota ?? 0) - (est.usage ?? 0);
    return headroom >= HEADROOM_FACTOR * spec.totalBytes ? 'ok' : 'low-storage';
  } catch {
    return 'ok';
  }
}

async function isModelFullyCached(spec: AiModelSpec, store: CacheLike): Promise<boolean> {
  for (const file of spec.files) {
    if (!(await isFileCompleteInStore(store, hfFileUrl(spec, file.path), file.size))) {
      return false;
    }
  }
  return true;
}

/** Marker present = the exact byte set was hash-verified after its last change. */
export async function isModelVerified(spec: AiModelSpec, store: CacheLike): Promise<boolean> {
  const marker = await store.match(verifiedMarkerKey(spec.revision));
  return marker !== undefined;
}

/** Read the network body into one buffer, counting bytes for progress. */
async function readWithProgress(
  body: ReadableStream<Uint8Array>,
  onChunk: (loadedDelta: number) => void,
): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    onChunk(value.byteLength);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/**
 * Usable = complete AND verified (D3 verify-then-trust). A set interrupted
 * between the last cache.put and the marker write is complete but NEVER
 * hashed — it must count as not-cached so ensureModelDownloaded re-verifies
 * it (zero network) before anything loads it.
 */
export async function isCacheUsable(
  spec: AiModelSpec,
  store: CacheLike,
  filesCached: number,
  filesTotal: number,
): Promise<boolean> {
  return filesTotal > 0 && filesCached === filesTotal && (await isModelVerified(spec, store));
}

/**
 * Ensure every manifest file is in the store (fetching what is missing),
 * then hash-verify the STORED copies. Throws ModelVerifyError (after
 * removing the model) or ModelQuotaError on quota exhaustion.
 */
export async function ensureModelDownloaded(
  spec: AiModelSpec,
  signal: AbortSignal,
  deps: DownloadDeps,
): Promise<{ bytes: number; downloaded: number }> {
  const { cacheStore: store, onProgress } = deps;
  onProgress?.({ phase: 'persist', percent: null });
  const persisted = await requestPersistence(deps);

  onProgress?.({ phase: 'preflight', percent: null });
  const storage = await preflightStorage(spec, deps);
  if (storage === 'low-storage') {
    onProgress?.({ phase: 'preflight', percent: null, warning: 'low-storage' });
  }

  const markerOK = await isModelVerified(spec, store);
  const fullyCached = markerOK && (await isModelFullyCached(spec, store));
  if (fullyCached) {
    onProgress?.({ phase: 'done', percent: 100 });
    return { bytes: spec.totalBytes, downloaded: 0 };
  }

  let doneBytes = 0;
  let downloaded = 0;
  for (const file of spec.files) {
    const url = hfFileUrl(spec, file.path);
    if (await isFileCompleteInStore(store, url, file.size)) {
      doneBytes += file.size;
      continue;
    }
    signal.throwIfAborted();
    onProgress?.({ phase: 'downloading', file: file.path, loaded: doneBytes, total: spec.totalBytes, percent: Math.round((doneBytes / spec.totalBytes) * 100) });
    const res = await deps.fetchImpl(url, { signal });
    if (!res.ok || !res.body) throw new Error(`Model file fetch failed: ${file.path} → ${res.status}`);
    // Read with byte progress, then store in ≤64MB parts (whole-file puts
    // of the 321MB shard fail in dedicated workers — see the module header).
    let loaded = 0;
    const buf = await readWithProgress(res.body, (delta) => {
      loaded += delta;
      onProgress?.({
        phase: 'downloading',
        file: file.path,
        loaded: doneBytes + loaded,
        total: spec.totalBytes,
        percent: Math.min(99, Math.round(((doneBytes + loaded) / spec.totalBytes) * 100)),
      });
    });
    if (buf.byteLength !== file.size) {
      throw new Error(`Model file truncated: ${file.path} → ${buf.byteLength}/${file.size} bytes`);
    }
    const keys = chunkKeys(url, file.size);
    try {
      for (let i = 0; i < keys.length; i += 1) {
        const start = i * MODEL_CHUNK_BYTES;
        const view = new Uint8Array(buf, start, Math.min(MODEL_CHUNK_BYTES, buf.byteLength - start));
        await store.put(keys[i], new Response(view));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // Genuinely a quota error → the friendly class; ANYTHING else (network
      // drop inside the pipe, SW hiccup, TypeError) must keep its real
      // message — mislabeling it "quota exceeded" sends users to free disk
      // space for a connectivity bug (review P2-7, hand-test round 2026-10-09).
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        throw new ModelQuotaError(err);
      }
      // File context: "Unexpected internal error" alone is undebuggable.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cache.put failed for ${file.path}: ${msg}`, { cause: err });
    }
    doneBytes += file.size;
    downloaded += file.size;
  }

  // Verify the STORED copies (F1/D3) — reassembled from their parts,
  // sequential to bound peak memory at the largest shard. Any download
  // invalidates the previous marker.
  onProgress?.({ phase: 'verifying', percent: 99 });
  const bad: string[] = [];
  for (const file of spec.files) {
    const buf = await readModelFile(store, hfFileUrl(spec, file.path), file.size);
    if (!buf) {
      bad.push(file.path);
      continue;
    }
    const hex = await sha256Hex(buf);
    if (hex !== file.sha256) bad.push(file.path);
  }
  if (bad.length > 0) {
    await clearModelCache(spec, store);
    throw new ModelVerifyError(bad[0]);
  }
  await store.put(
    verifiedMarkerKey(spec.revision),
    new Response(JSON.stringify({ verifiedAt: Date.now(), persisted }), { headers: { 'content-type': 'application/json' } }),
  );
  onProgress?.({ phase: 'done', percent: 100 });
  return { bytes: doneBytes, downloaded };
}

/** Remove every model part + the verified marker. Returns entries deleted. */
export async function clearModelCache(spec: AiModelSpec, store: CacheLike): Promise<number> {
  const urls: string[] = [verifiedMarkerKey(spec.revision)];
  for (const file of spec.files) {
    urls.push(...chunkKeys(hfFileUrl(spec, file.path), file.size));
  }
  let deleted = 0;
  for (const url of urls) {
    if (await store.delete(url)) deleted += 1;
  }
  return deleted;
}
