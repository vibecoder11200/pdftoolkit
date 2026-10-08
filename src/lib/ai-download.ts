/*
 * Model download + verify (v0.5.0 phase 2a, D3/D11). Runs inside the AI
 * worker (every network call — the app CSP forbids main-thread model
 * fetches); deps are injectable so vitest can drive abort/quota/mismatch
 * paths against fakes.
 *
 * Abort contract (spec'd strategy of the two in phase-2a): files are stored
 * whole via a streamed cache.put — an aborted file leaves NO partial entry,
 * while completed files persist, so a retry only fetches what is missing
 * (per-file resume). The alternative clear-and-restart path is
 * clearModelCache(), used by Settings.
 *
 * Verify (D3): after the last put, EVERY file is read BACK from the Cache
 * API copy and hashed — never the RAM/network buffer. A mismatch deletes
 * the whole model from the store and throws ModelVerifyError. The verified
 * marker is written once per revision: the cache-hit path skips re-hashing
 * on every use (verified-once), but any new download invalidates it.
 */
import {
  hfFileUrl,
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
    if (!(await store.match(hfFileUrl(spec, file.path)))) return false;
  }
  return true;
}

/** Marker present = the exact byte set was hash-verified after its last change. */
export async function isModelVerified(spec: AiModelSpec, store: CacheLike): Promise<boolean> {
  const marker = await store.match(verifiedMarkerKey(spec.revision));
  return marker !== undefined;
}

/**
 * Identity TransformStream probe: counts bytes for progress WITHOUT
 * buffering the file (backpressure flows through to the network; cache.put
 * writes at disk speed and the stream simply throttles).
 */
function countedBody(
  body: ReadableStream<Uint8Array>,
  onChunk: (loadedDelta: number) => void,
): ReadableStream<Uint8Array> {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onChunk(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
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
    if (await store.match(url)) {
      doneBytes += file.size;
      continue;
    }
    signal.throwIfAborted();
    onProgress?.({ phase: 'downloading', file: file.path, loaded: doneBytes, total: spec.totalBytes, percent: Math.round((doneBytes / spec.totalBytes) * 100) });
    const res = await deps.fetchImpl(url, { signal });
    if (!res.ok || !res.body) throw new Error(`Model file fetch failed: ${file.path} → ${res.status}`);
    let loaded = 0;
    const piped = countedBody(res.body, (delta) => {
      loaded += delta;
      onProgress?.({
        phase: 'downloading',
        file: file.path,
        loaded: doneBytes + loaded,
        total: spec.totalBytes,
        percent: Math.min(99, Math.round(((doneBytes + loaded) / spec.totalBytes) * 100)),
      });
    });
    try {
      await store.put(url, new Response(piped, { headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' } }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ModelQuotaError(err);
    }
    doneBytes += file.size;
    downloaded += file.size;
  }

  // Verify the STORED copies (F1/D3) — sequential to bound peak memory at
  // the largest shard. Any download invalidates the previous marker.
  onProgress?.({ phase: 'verifying', percent: 99 });
  const bad: string[] = [];
  for (const file of spec.files) {
    const res = await store.match(hfFileUrl(spec, file.path));
    if (!res) {
      bad.push(file.path);
      continue;
    }
    const hex = await sha256Hex(await res.arrayBuffer());
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

/** Remove every model entry + the verified marker. Returns entries deleted. */
export async function clearModelCache(spec: AiModelSpec, store: CacheLike): Promise<number> {
  const urls = [...spec.files.map((f) => hfFileUrl(spec, f.path)), verifiedMarkerKey(spec.revision)];
  let deleted = 0;
  for (const url of urls) {
    if (await store.delete(url)) deleted += 1;
  }
  return deleted;
}
