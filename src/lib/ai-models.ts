/*
 * AI model registry (v0.5.0 phase 2a, D8): exactly ONE exposed AI model per
 * the SPIKE verdict — GLM-OCR (onnx-community ONNX port, q4f16). The pin is
 * the HF commit SHA (NOT "main" — moving target) plus the committed
 * sha256-per-file manifest (scripts/ai-model-manifest.json, D3): download
 * verification hashes the Cache API copy, never the network buffer.
 *
 * pipelineOptions() is the SHARED canonical tuple (task + modelId + dtype +
 * revision, F15) — every path that checks, downloads, loads or deletes the
 * model MUST go through it so cache reconciliation compares identical
 * arguments.
 *
 * SPIKE finding baked in here: the repo's config.json
 * transformers.js_config.use_external_data_format omits the q4f16 entries
 * (fp16/quantized only), so transformers.js would try to create sessions
 * without mounting the *_data shards ("Module.MountedFiles is not
 * available"). useExternalDataFormat forces one external-data chunk per
 * module — correct for q4f16, where every module has exactly one _data file.
 */
import manifest from '../../scripts/ai-model-manifest.json';

/** Cache API store owned by this app for model weights (Settings-managed). */
export const AI_CACHE_STORE = 'pdftoolkit-ai-v1';

/** The single exposed AI model id (D8). */
export const AI_MODEL_ID = 'glm-ocr';

export interface AiModelFile {
  path: string;
  size: number;
  sha256: string;
}

export type AiDtypeMap = {
  embed_tokens: 'q4f16';
  vision_encoder: 'q4f16';
  decoder_model_merged: 'q4f16';
};

export interface AiModelSpec {
  id: string;
  task: 'image-text-to-text';
  repo: string;
  /** HF commit SHA — never a moving ref. */
  revision: string;
  license: string;
  upstreamRepo: string;
  upstreamLicense: string;
  dtype: AiDtypeMap;
  useExternalDataFormat: boolean;
  /** Model weights + configs, from the committed manifest. */
  files: AiModelFile[];
  weightsBytes: number;
  totalBytes: number;
}

function specFromManifest(id: string, task: AiModelSpec['task'], dtype: AiDtypeMap): AiModelSpec {
  const files = manifest.files as AiModelFile[];
  const weightsBytes = files
    .filter((f) => f.path.endsWith('.onnx_data'))
    .reduce((sum, f) => sum + f.size, 0);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return {
    id,
    task,
    repo: manifest.repo,
    revision: manifest.revision,
    license: manifest.license,
    upstreamRepo: manifest.upstream.repo,
    upstreamLicense: manifest.upstream.license,
    dtype,
    useExternalDataFormat: true,
    files,
    weightsBytes,
    totalBytes,
  };
}

/** The exposed models — length 1 by decision D8 (granite only if SPIKE PARTIAL). */
export const AI_MODELS: readonly AiModelSpec[] = [
  specFromManifest(AI_MODEL_ID, 'image-text-to-text', {
    embed_tokens: 'q4f16',
    vision_encoder: 'q4f16',
    decoder_model_merged: 'q4f16',
  }),
];

export function getModelSpec(id: string): AiModelSpec {
  const spec = AI_MODELS.find((m) => m.id === id);
  if (!spec) throw new Error(`Unknown AI model: ${id}`);
  return spec;
}

/** The canonical load/check/delete options — every ModelRegistry call uses these. */
export interface PipelineOptions {
  task: AiModelSpec['task'];
  modelId: string;
  revision: string;
  dtype: AiDtypeMap;
  use_external_data_format: boolean;
}

export function pipelineOptions(id: string): PipelineOptions {
  const spec = getModelSpec(id);
  return {
    task: spec.task,
    modelId: spec.repo,
    revision: spec.revision,
    dtype: spec.dtype,
    use_external_data_format: spec.useExternalDataFormat,
  };
}

/** HF resolve URL — the exact cache key transformers.js derives for a file. */
export function hfFileUrl(spec: Pick<AiModelSpec, 'repo' | 'revision'>, path: string): string {
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${path}`;
}

/**
 * Same-origin ORT wasm locations (F1): scripts/sync-ort-assets.mjs copies the
 * jsep build to public/ort/ at build time; the worker pins these into
 * env.backends.onnx.wasm.wasmPaths so the factory NEVER loads from jsDelivr
 * (the transformers.js default — a no-CDN violation). `baseUrl` is
 * import.meta.env.BASE_URL ('/pdftoolkit/' web, '/' desktop).
 */
export function sameOriginWasmPaths(baseUrl: string): { mjs: string; wasm: string } {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return {
    mjs: `${base}ort/ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${base}ort/ort-wasm-simd-threaded.jsep.wasm`,
  };
}

/**
 * Zero-network cached-state check for labels (config step, D4 pre-download
 * tier 1-4): reads OUR Cache API store directly against the committed
 * manifest — no transformers import, no HF HEAD calls (offline-honest).
 * The worker's ModelRegistry path stays the authoritative verify.
 */
/**
 * Open the AI store WITHOUT recreating it: caches.open() materializes a
 * deleted store as empty, so a Settings "clear" would look undone to
 * caches.keys(). has() first keeps a delete a delete.
 */
async function openAiStoreOrNull(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    if (!(await caches.has(AI_CACHE_STORE))) return null;
    return await caches.open(AI_CACHE_STORE);
  } catch {
    return null;
  }
}

export async function isModelCachedLocally(): Promise<boolean> {
  const store = await openAiStoreOrNull();
  if (!store) return false;
  try {
    const spec = getModelSpec(AI_MODEL_ID);
    for (const file of spec.files) {
      if (!(await store.match(hfFileUrl(spec, file.path)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Bytes of manifest files already present in the store (Settings rows). */
export async function cachedModelBytes(): Promise<number> {
  const store = await openAiStoreOrNull();
  if (!store) return 0;
  try {
    const spec = getModelSpec(AI_MODEL_ID);
    let bytes = 0;
    for (const file of spec.files) {
      if (await store.match(hfFileUrl(spec, file.path))) bytes += file.size;
    }
    return bytes;
  } catch {
    return 0;
  }
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type DownloadPhase = 'persist' | 'preflight' | 'downloading' | 'verifying' | 'done';

export interface DownloadProgress {
  phase: DownloadPhase;
  /** File currently transferring, when phase = downloading. */
  file?: string;
  loaded?: number;
  total?: number;
  /** 0-100 across ALL model files; null when indeterminate. */
  percent: number | null;
  /** Pre-flight headroom warning (D11) — never blocks. */
  warning?: 'low-storage';
}

export class ModelVerifyError extends Error {
  constructor(path: string) {
    super(`sha256 mismatch for ${path} — cached model file is corrupt; it has been removed.`);
    this.name = 'ModelVerifyError';
  }
}

export class ModelQuotaError extends Error {
  constructor(cause: unknown) {
    super('Not enough storage to keep the model (quota exceeded). Free space and retry.', { cause });
    this.name = 'ModelQuotaError';
  }
}

/** Verified marker entry inside AI_CACHE_STORE (1-time verify per revision). */
export function verifiedMarkerKey(revision: string): string {
  return `__verified__/${revision}`;
}
