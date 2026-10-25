import type { ErrorDetail } from '../components/ui/error-banner';

/**
 * Engine-crash mapping for the WorkspaceShell error contract (v0.8.1 phase
 * 3F). An EngineCrashedError becomes { title, detail, onRetry } — the Retry
 * button reruns the tool's last run; the op NEVER re-runs by itself (D4: an
 * op that already delivered must never silently re-run). Name-based check:
 * the error crosses comlink message-only, so instanceof is unreliable (same
 * convention as isEncryptedError in suggest.ts).
 */
export function isEngineCrashedError(err: unknown): boolean {
  return err instanceof Error && err.name === 'EngineCrashedError';
}

/**
 * Redact typed errors (v0.9.0 phase 2) — name-based across comlink:
 * RedactRefusedError (pre-mutation refusal: signed/encrypted/vertical text/
 * partial coverage/no raster for a flagged page) vs RedactVerifyError
 * (post-output residue — output discarded, fail closed) vs RedactParseError
 * (parse anomaly, output untouched).
 */
export function isRedactRefusedError(err: unknown): boolean {
  return err instanceof Error && err.name === 'RedactRefusedError';
}
export function isRedactVerifyError(err: unknown): boolean {
  return err instanceof Error && err.name === 'RedactVerifyError';
}
export function isRedactParseError(err: unknown): boolean {
  return err instanceof Error && err.name === 'RedactParseError';
}

/**
 * Maps an engine failure to the shell's error prop: crashed → ErrorDetail
 * with the Retry affordance; anything else keeps the caller's legacy string
 * (so existing per-tool error copy is untouched).
 */
export function engineErrorDetail(
  err: unknown,
  legacy: string,
  crashed: { title: string; detail: string },
  onRetry: () => void,
): string | ErrorDetail {
  return isEngineCrashedError(err) ? { title: crashed.title, detail: crashed.detail, onRetry } : legacy;
}
