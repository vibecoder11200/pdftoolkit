import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Channel } from '@tauri-apps/api/core';

/*
 * Channel byte-compatibility sanity (v0.6.0 phase 6, R6.1 step 1 — the
 * load-bearing proof of the mock seam): the REAL Channel class from
 * @tauri-apps/api/core runs against the SAME registry + frame shapes
 * tests/helpers/tauri-mock.ts installs in the browser. If the mock's
 * `{message,index}` / `{end,index}` frames ever drift from what the real
 * bridge injects, THIS spec fails in `npm test`, not in the field.
 */

type RawFrame = { index: number; message?: unknown; end?: boolean };

const registry: Record<number, ((raw: RawFrame) => void) | undefined> = {};
let nextId = 1;

beforeEach(() => {
  nextId = 1;
  for (const k of Object.keys(registry)) delete registry[Number(k)];
  (globalThis as unknown as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: (raw: RawFrame) => void, once?: boolean) => {
        const id = nextId++;
        registry[id] = once
          ? (raw: RawFrame) => {
              registry[id] = undefined;
              cb(raw);
            }
          : cb;
        return id;
      },
      unregisterCallback: (id: number) => {
        delete registry[id];
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
});

describe('tauri-mock frame shapes vs the REAL Channel class', () => {
  it('delivers {message,index} frames in order (even pushed out of order) and {end,index} cleans up', () => {
    const seen: string[] = [];
    const ch = new Channel<string>((m) => seen.push(m));
    expect(typeof ch.id).toBe('number');
    // Out-of-order push — the REAL class buffers index 1, delivers index 0
    // and immediately drains the pending 'second' (ordering restored).
    registry[ch.id]?.({ message: 'second', index: 1 });
    registry[ch.id]?.({ message: 'first', index: 0 });
    registry[ch.id]?.({ end: true, index: 2 });
    expect(seen).toEqual(['first', 'second']);
    // The terminal frame ran the real cleanup → the callback unregistered.
    expect(registry[ch.id]).toBeUndefined();
  });

  it('once-callbacks self-unregister (the registry mirrors transformCallback(once))', () => {
    const hits: unknown[] = [];
    const id = (
      globalThis as unknown as {
        window: {
          __TAURI_INTERNALS__: {
            transformCallback: (cb: (raw: unknown) => void, once?: boolean) => number;
          };
        };
      }
    ).window.__TAURI_INTERNALS__.transformCallback((raw: unknown) => hits.push(raw), true);
    registry[id]?.({ index: 0, message: 1 });
    registry[id]?.({ index: 1, message: 2 });
    expect(hits).toEqual([{ index: 0, message: 1 }]);
    expect(registry[id]).toBeUndefined();
  });
});
