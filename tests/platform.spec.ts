import { describe, expect, it } from 'vitest';
import { isTauri } from '../src/lib/platform';

// Phase 1 (D6) unit gate: the Tauri internals global is the only runtime
// signal — its presence must flip isTauri() deterministically.
describe('isTauri', () => {
  const KEY = '__TAURI_INTERNALS__';
  const globals = globalThis as Record<string, unknown>;

  it('is false on the web (no Tauri internals)', () => {
    delete globals[KEY];
    expect(isTauri()).toBe(false);
  });

  it('is true when __TAURI_INTERNALS__ is present', () => {
    globals[KEY] = {};
    try {
      expect(isTauri()).toBe(true);
    } finally {
      delete globals[KEY];
    }
  });
});
