import { WorkerCrashError } from './ai-worker-client';

/*
 * Typed native-engine errors (v0.6.0 phase 4, R4.3, review F4).
 *
 * Dependency-free in the sense that matters: NO `@tauri-apps/api` import —
 * this module is importable by `ai-run.ts` (entry bundle) AND the lazily
 * loaded native client. Every class extends `WorkerCrashError`, so the crash
 * classifier in `runAiPages` (ai-run.ts:180-188) already matches them —
 * page-indexed resume works for native crashes with zero classifier logic
 * changes.
 */
export class NativeEngineError extends WorkerCrashError {
  constructor(message: string, cause?: unknown) {
    super(cause);
    this.name = 'NativeEngineError';
    this.message = message;
  }
}

export class OomError extends NativeEngineError {
  constructor() {
    super('Native engine ran out of memory during model load.');
    this.name = 'OomError';
  }
}

export class QuarantinedError extends NativeEngineError {
  constructor(detail?: string | null) {
    super(
      detail
        ? `Engine binary missing, blocked, or altered: ${detail}`
        : 'Engine binary missing, blocked, or altered.',
    );
    this.name = 'QuarantinedError';
  }
}

export class CrashedError extends NativeEngineError {
  constructor(detail?: string | null) {
    super(detail ? `Engine crashed: ${detail}` : 'Engine crashed.');
    this.name = 'CrashedError';
  }
}

export class DownloadFailedError extends NativeEngineError {
  constructor(detail?: string | null) {
    super(detail ? `Engine download failed: ${detail}` : 'Engine download failed.');
    this.name = 'DownloadFailedError';
  }
}

export class StartTimeoutError extends NativeEngineError {
  constructor() {
    super('Engine startup timed out.');
    this.name = 'StartTimeoutError';
  }
}

export class BlockedByOsError extends NativeEngineError {
  constructor() {
    super('The OS blocked the engine launch.');
    this.name = 'BlockedByOsError';
  }
}

export class OsTooOldError extends NativeEngineError {
  constructor(detail?: string | null) {
    super(detail ? `System too old for the engine: ${detail}` : 'System too old for the engine.');
    this.name = 'OsTooOldError';
  }
}

/**
 * Map a rejected `invoke` payload (`{kind, detail}` — ipc::CommandError) to
 * a typed error. Unknown kinds keep their detail in the base class; a plain
 * Error passes through unchanged.
 */
export function toNativeEngineError(err: unknown): Error {
  const shape = err as { kind?: unknown; detail?: unknown };
  if (shape && typeof shape === 'object' && typeof shape.kind === 'string') {
    const detail = typeof shape.detail === 'string' ? shape.detail : null;
    switch (shape.kind) {
      case 'quarantined':
        return new QuarantinedError(detail);
      case 'oom':
        return new OomError();
      case 'crashed':
        return new CrashedError(detail);
      case 'download':
        return new DownloadFailedError(detail);
      case 'start-timeout':
        return new StartTimeoutError();
      case 'os-blocked':
        return new BlockedByOsError();
      case 'os-too-old':
        return new OsTooOldError(detail);
      default:
        return new NativeEngineError(detail ?? `Native engine error: ${shape.kind}`, err);
    }
  }
  if (err instanceof Error) return err;
  return new NativeEngineError(String(err), err);
}
