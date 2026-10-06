// In-memory handoff: carries dropped File handles from the home suggestion
// sheet to the destination tool page. Files stay untouched `File` objects —
// cheap handles; bytes are read exactly once by the receiving tool's `add()`
// (magic-byte + size validation included), never duplicated here.
export interface PendingHandoff {
  files: File[];
  meta?: { mode?: 'decrypt' };
}

type Listener = (pending: PendingHandoff) => void;

let pending: PendingHandoff | null = null;
const listeners = new Set<Listener>();

export function setPendingFiles(files: File[], meta?: PendingHandoff['meta']): void {
  pending = { files, meta };
  for (const listener of listeners) listener(pending);
}

/**
 * One-shot: the first take wins, later takes return null. This is what makes
 * StrictMode's double-invoked effects safe — the second take is a no-op
 * instead of a second `add()`.
 */
export function takePendingFiles(): PendingHandoff | null {
  const taken = pending;
  pending = null;
  return taken;
}

export function hasPendingFiles(): boolean {
  return pending !== null;
}

/** Reactive hook for the home sheet: fires whenever pending appears. */
export function onPending(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Drop without consuming (sheet close / navigation cancel). */
export function clearPendingFiles(): void {
  pending = null;
}
