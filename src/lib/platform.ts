// Plan v0.4.0 phase 1 (D6): runtime platform gate for SW registration and
// the desktop intake/updater adapters. Mirrors the check
// @tauri-apps/api/core's isTauri() performs without importing that module —
// importers of this file live in the entry bundle, and the api/core import
// would drag it in just for this boolean.
export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in globalThis;
}
