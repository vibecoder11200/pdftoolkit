/*
 * Hand-synced TS mirror of the Rust IPC types (v0.6.0 phase 4, R4.1).
 * Single shape, no codegen in this repo: `src-tauri/src/native_engine/ipc.rs`
 * is the source of truth — edit the two together. NativeStatus deliberately
 * has NO token and NO port field (type-enforced on the Rust side).
 */

export type NativePhase =
  | 'notInstalled'
  | 'versionChecking'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'dead';

export type NativeBackend = 'unknown' | 'vulkan' | 'cuda' | 'metal' | 'cpu';

export type NativeDownloadKind = 'engine' | 'cuda' | 'model';

/** Serialized `ipc::CommandError` — `kind` is the stable key from
 *  `EngineError::key()` (or 'download' | 'invalid' | 'busy' | 'io' |
 *  'cancelled'); native-errors.ts maps it to typed errors. */
export interface NativeCommandErrorShape {
  kind: string;
  detail?: string | null;
}

export interface NativeStatus {
  phase: NativePhase;
  backend: NativeBackend | null;
  cpuFallback: boolean | null;
  devices: string[] | null;
  enginePresent: boolean;
  modelPresent: boolean;
  cudaPresent: boolean;
  sizes: { engine: number; cuda: number; model: number };
  lastError: NativeCommandErrorShape | null;
}

/** Rust `download::ProgressFrame` (single-word fields, same on the wire). */
export interface NativeDownloadFrame {
  phase: string;
  loaded: number;
  total: number;
  percent: number;
}

/** Rust `ocr::TokenFrame` — `tokenDelta` counts the tokens in `delta` so the
 *  client can keep the per-token counter honest across ~40ms batched frames
 *  (review F4). */
export interface NativeTokenFrame {
  delta: string;
  tokenDelta: number;
  done: boolean;
}

/** Rust `ocr::OcrPageResult`. */
export interface NativeOcrPageResult {
  text: string;
  ms: number;
  firstTokenMs: number;
  genTokens: number;
  tokPerSec: number;
}
