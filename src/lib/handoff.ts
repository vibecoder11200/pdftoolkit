// In-memory handoff: carries dropped File handles from the home suggestion
// sheet to the destination tool page. Files stay untouched `File` objects —
// cheap handles; bytes are read exactly once by the receiving tool's `add()`
// (magic-byte + size validation included), never duplicated here.
export interface PendingHandoff {
  files: File[];
  meta?: { mode?: 'decrypt' };
}

type Listener = (pending: PendingHandoff) => void;
type ClearedListener = () => void;

let pending: PendingHandoff | null = null;
const listeners = new Set<Listener>();
const clearedListeners = new Set<ClearedListener>();

export function setPendingFiles(files: File[], meta?: PendingHandoff['meta']): void {
  pending = { files, meta };
  for (const listener of listeners) listener(pending);
}

/**
 * A second OS launch (or drop) while files are parked must not silently
 * destroy the first batch — append instead of replace.
 */
export function appendPendingFiles(files: File[], meta?: PendingHandoff['meta']): void {
  setPendingFiles(pending ? [...pending.files, ...files] : files, meta ?? pending?.meta);
}

/**
 * One-shot: the first take wins, later takes return null. This is what makes
 * StrictMode's double-invoked effects safe — the second take is a no-op
 * instead of a second `add()`.
 */
export function takePendingFiles(): PendingHandoff | null {
  const taken = pending;
  if (pending) {
    pending = null;
    notifyCleared();
  }
  return taken;
}

export function hasPendingFiles(): boolean {
  return pending !== null;
}

/** Total parked file count (the launch banner reports this). */
export function pendingFileCount(): number {
  return pending?.files.length ?? 0;
}

/**
 * Reactive hook for the home sheet: fires on set AND replays the current
 * handoff to new subscribers. The replay is what makes the launch banner's
 * "open Home" action work — files parked while Home was unmounted would
 * otherwise sit invisible in the handoff. Safe because every consumer path
 * either consumes (take) or clears the pending handoff.
 */
export function onPending(fn: Listener): () => void {
  listeners.add(fn);
  if (pending) fn(pending);
  return () => listeners.delete(fn);
}

/** Drop without consuming (sheet close / navigation cancel). */
export function clearPendingFiles(): void {
  if (pending) {
    pending = null;
    notifyCleared();
  }
}

/**
 * Fires when the handoff empties (taken by a tool or dismissed) — the launch
 * banner listens so it stops advertising files that are no longer parked.
 */
export function onCleared(fn: ClearedListener): () => void {
  clearedListeners.add(fn);
  return () => clearedListeners.delete(fn);
}

function notifyCleared(): void {
  for (const listener of clearedListeners) listener();
}
