import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * AiNativeClient state-machine suite (v0.6.0 phase 4 step 4 — written with
 * the code; phase 6 extends it). `@tauri-apps/api/core` is module-mocked:
 * invoke() reads a scripted handler, Channel captures the frame sink so a
 * test can push Rust-side frames. isTauri() is driven by stubbing
 * globalThis.__TAURI_INTERNALS__ (platform.ts's actual detection).
 */

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const state = {
  handler: null as InvokeHandler | null,
  channels: [] as Array<{ onmessage: ((m: unknown) => void) | null }>,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    if (!state.handler) throw new Error('no scripted invoke handler');
    return state.handler(cmd, args);
  }),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
    constructor() {
      state.channels.push(this);
    }
  },
}));

import { sharedNativeClient, AiNativeClient } from '../src/lib/ai-native-client';
import {
  DownloadFailedError,
  OomError,
  QuarantinedError,
  StartTimeoutError,
  toNativeEngineError,
} from '../src/lib/native-errors';
import type { NativeStatus } from '../src/lib/native-types';

const READY: NativeStatus = {
  phase: 'ready',
  backend: 'vulkan',
  cpuFallback: false,
  devices: ['Vulkan1: Radeon'],
  enginePresent: true,
  modelPresent: true,
  cudaPresent: false,
  sizes: { engine: 100, cuda: 0, model: 200 },
  lastError: null,
};

function desktop(on: boolean): void {
  if (on) {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

function script(handler: InvokeHandler): void {
  state.handler = handler;
  state.channels.length = 0;
}

beforeEach(() => {
  desktop(true);
});
afterEach(() => {
  desktop(false);
});

describe('native client state machine', () => {
  it('refuses everything on web (isTauri false)', async () => {
    desktop(false);
    const client = sharedNativeClient();
    await expect(client.ensureLoaded('glm-ocr', () => {})).rejects.toThrow(/desktop-only/);
    await expect(client.isCached('glm-ocr')).rejects.toThrow();
  });

  it('not-installed → download engine → download model (first-use flow order)', async () => {
    const order: Array<[string, string | undefined]> = [];
    let engineDone = false;
    script(async (cmd, args) => {
      order.push([cmd, args?.kind as string | undefined]);
      if (cmd === 'native_engine_status') {
        return { ...READY, enginePresent: engineDone, modelPresent: false };
      }
      if (cmd === 'native_engine_download') {
        if (args?.kind === 'engine') engineDone = true;
        return 1234;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const client = new AiNativeClient();
    await client.downloadModel('glm-ocr', () => {});
    expect(order.map(([cmd, kind]) => `${cmd}:${kind ?? '-'}`)).toEqual([
      'native_engine_status:-',
      'native_engine_download:engine',
      'native_engine_download:model',
    ]);
  });

  it('downloadModel maps Channel frames onto the DownloadProgress shape', async () => {
    const seen: Array<{ percent: number | null; loaded?: number; total?: number }> = [];
    script(async (cmd, args) => {
      if (cmd === 'native_engine_status') return { ...READY, enginePresent: false, modelPresent: false };
      if (cmd === 'native_engine_download') {
        const ch = args?.onProgress as { onmessage: ((f: unknown) => void) | null };
        ch.onmessage?.({ phase: 'downloading', loaded: 50, total: 100, percent: 50 });
        return 100;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const client = new AiNativeClient();
    await client.downloadModel('glm-ocr', (p) => seen.push({ percent: p.percent, loaded: p.loaded, total: p.total }));
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual({ percent: 50, loaded: 50, total: 100 });
  });

  it('ensureLoaded returns the NON-NULL native fingerprint + backend (review F2/F14)', async () => {
    script(async (cmd) => (cmd === 'native_engine_start' ? READY : undefined));
    const client = new AiNativeClient();
    const load = await client.ensureLoaded('glm-ocr', () => {});
    expect(load).toEqual({
      loadMs: expect.any(Number),
      device: 'native',
      adapterFingerprint: 'native',
      backend: 'vulkan',
    });
  });

  it('ocrPage pushes frames and sums tokenDelta into tokenCount (review F4)', async () => {
    script(async (cmd, args) => {
      if (cmd === 'native_ocr_page') {
        const ch = args?.onToken as { onmessage: ((f: unknown) => void) | null };
        ch.onmessage?.({ delta: 'Xin ', tokenDelta: 2, done: false });
        ch.onmessage?.({ delta: 'chào', tokenDelta: 1, done: false });
        return { text: 'Xin chào', ms: 900, firstTokenMs: 120, genTokens: 3, tokPerSec: 3.3 };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const client = new AiNativeClient();
    let chunks = '';
    const r = await client.ocrPage({ data: new Uint8ClampedArray(4), width: 1, height: 1, dataUrl: 'data:image/png;base64,AAA' } as never, (c) => {
      chunks += c;
    });
    expect(chunks).toBe('Xin chào');
    expect(client.tokenCount).toBe(3);
    expect(r.text).toBe('Xin chào');
    expect(r.firstTokenMs).toBe(120);
  });

  it('ocrPage without a dataUrl fails fast (the ONE dataUrl mechanism)', async () => {
    script(async () => undefined);
    const client = new AiNativeClient();
    await expect(
      client.ocrPage({ data: new Uint8ClampedArray(4), width: 1, height: 1 } as never, () => {}),
    ).rejects.toThrow(/dataUrl/);
  });

  it('CommandError shapes map to typed WorkerCrashError subclasses', async () => {
    script(async (cmd) => {
      if (cmd === 'native_engine_start') {
        throw { kind: 'oom', detail: null }; // eslint-disable-line no-throw-literal
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const client = new AiNativeClient();
    await expect(client.ensureLoaded('glm-ocr', () => {})).rejects.toBeInstanceOf(OomError);
    expect(toNativeEngineError({ kind: 'quarantined', detail: 'x' })).toBeInstanceOf(QuarantinedError);
    expect(toNativeEngineError({ kind: 'download', detail: 'hash mismatch' })).toBeInstanceOf(
      DownloadFailedError,
    );
    expect(toNativeEngineError({ kind: 'start-timeout' })).toBeInstanceOf(StartTimeoutError);
  });

  it('singleton: the whole app drives ONE client (review F1)', () => {
    expect(sharedNativeClient()).toBe(sharedNativeClient());
  });
});
