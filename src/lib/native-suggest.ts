/*
 * Smart-suggestion dismiss store (v0.6.0 phase 5, R5.1) — an observable
 * localStorage store copying the gpu-choice pattern (:134/:160-190). ONE
 * concern, ONE key. The stored record carries the app version it was
 * dismissed under: a NEW version re-arms the suggestion once, so a future
 * faster engine can be re-suggested without a store wipe (plan Risk 2's
 * locked default: per-release re-arm; tightening to semver-major is a
 * one-line change here).
 */

export const NATIVE_SUGGEST_KEY = 'pdftoolkit-native-suggest-dismissed';

interface DismissRecord {
  at: number;
  version: string;
}

function readDismissed(): DismissRecord | null {
  try {
    const raw = localStorage.getItem(NATIVE_SUGGEST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = parsed as { at?: unknown; version?: unknown };
    if (typeof v.at !== 'number' || typeof v.version !== 'string') return null;
    return { at: v.at, version: v.version };
  } catch {
    return null;
  }
}

let cached: DismissRecord | null = typeof localStorage === 'undefined' ? null : readDismissed();
const listeners = new Set<() => void>();

/** useSyncExternalStore snapshot — true when dismissed AND still current
 *  (same app version). An old-version dismissal does NOT count: the
 *  suggestion re-arms once per release. */
export function isNativeSuggestDismissed(): boolean {
  return cached !== null && cached.version === __APP_VERSION__;
}

export function dismissNativeSuggest(): void {
  cached = { at: Date.now(), version: __APP_VERSION__ };
  try {
    localStorage.setItem(NATIVE_SUGGEST_KEY, JSON.stringify(cached));
  } catch {
    /* private mode — dismisses for this session only */
  }
  for (const listener of listeners) listener();
}

export function subscribeNativeSuggest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — suites must start from the default. */
export function resetNativeSuggestStore(): void {
  cached = null;
  try {
    localStorage.removeItem(NATIVE_SUGGEST_KEY);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}
