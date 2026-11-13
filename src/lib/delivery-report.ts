/*
 * Phase 3 delivery contract (plan 261112-0955, scope C). A multi-output
 * deliver returns a TYPED report instead of a boolean that can hide partial
 * delivery. Cancellation is distinct from failure; web downloads are
 * 'dispatched' (phase-3 contract: web downloads are dispatched, never
 * confirmed on disk); desktop saves are 'saved' with a display-only path.
 * Per-entry retry reuses the same artifact identity and a success ledger -
 * already-delivered bytes are never re-sent.
 */

export type DeliveryEntryStatus = 'saved' | 'dispatched' | 'failed' | 'skipped';

export interface DeliveryEntry {
  /** Stable identity: same value across retries of the same artifact. */
  artifactId: string;
  filename: string;
  status: DeliveryEntryStatus;
  /** Display-only saved path (desktop). Never used to address a write. */
  path?: string;
  /** Error text or i18n key for failed/skipped entries. */
  error?: string;
}

export type DeliveryOverall =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'dispatched';

export interface DeliveryReport {
  overall: DeliveryOverall;
  entries: DeliveryEntry[];
}

/** Overall derived from per-entry statuses; empty means cancelled (nothing attempted). */
export function deliveryOverall(entries: DeliveryEntry[]): DeliveryOverall {
  if (entries.length === 0) return 'cancelled';
  const dispatched = entries.filter((e) => e.status === 'dispatched').length;
  const bad = entries.filter((e) => e.status === 'failed' || e.status === 'skipped');
  if (bad.length === 0 && dispatched === 0) return 'complete';
  if (bad.length === 0 && dispatched > 0) return 'dispatched';
  const saved = entries.filter((e) => e.status === 'saved').length;
  if (saved > 0) return 'partial';
  return 'failed';
}

/** Explicit budget for retaining failed bytes for in-UI retry (phase-3: unbounded retention refused). */
export const RETRY_RETENTION_BUDGET = 100 * 1024 * 1024;

/** True when total bytes fit the explicit retry-retention budget. */
export function retentionBudgetOk(
  entries: readonly { bytes: Uint8Array; filename?: string }[],
): boolean {
  let total = 0;
  for (const e of entries) total += e.bytes.byteLength;
  return total <= RETRY_RETENTION_BUDGET;
}
