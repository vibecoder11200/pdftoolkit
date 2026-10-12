import type { Page } from '@playwright/test';

/*
 * Shared desktop mock seam (v0.6.0 phase 6, R6.1). Upgrades the per-spec
 * `transformCallback: () => 1` stub to the REAL bridge contract:
 * an id-keyed callback registry + `unregisterCallback`, and a frame pusher
 * that emits `{ message, index }` / `{ end, index }` — the byte shapes the
 * actual Tauri host injects for `Channel` (core.ts). The REAL Channel class
 * (from @tauri-apps/api/core, already bundled in dist-desktop) runs against
 * this mock unmodified — the sanity spec pins that byte-compatibility.
 *
 * Usage:
 *   await stubTauri(page);
 *   await page.addInitScript(() => {
 *     window.__tauriSetHandler('native_engine_status', () => ({ ... }));
 *   });
 *
 * NEVER import this from src/ — tests/src-purity.spec.ts is the gate.
 */

export type DesktopCall = { cmd: string; payload?: unknown; options?: unknown };

/**
 * Installs `__TAURI_INTERNALS__` with the registry-based mock. Must be
 * awaited BEFORE specs chain their own addInitScript handler installs
 * (init scripts run in registration order).
 */
export async function stubTauri(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: DesktopCall[] = [];
    const registry: Record<number, ((arg: unknown) => void) | undefined> = {};
    let nextId = 1;
    const handlers: Record<string, (payload?: unknown) => unknown> = {};
    (window as unknown as Record<string, unknown>).__desktopCalls = calls;
    (window as unknown as Record<string, unknown>).__tauriCallbacks = registry;
    (window as unknown as Record<string, unknown>).__tauriSetHandler = (
      cmd: string,
      fn: (payload?: unknown) => unknown,
    ) => {
      handlers[cmd] = fn;
    };
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, payload?: unknown, options?: unknown) => {
        calls.push({ cmd, payload, options });
        const handler = handlers[cmd];
        if (handler) return Promise.resolve(handler(payload));
        if (cmd === 'plugin:dialog|save')
          return Promise.resolve('C:\\Users\\tester\\Downloads\\ocr.md');
        if (cmd === 'initial_open_files') return Promise.resolve([]);
        if (cmd === 'plugin:event|listen') return Promise.resolve(1);
        if (cmd === 'plugin:updater|check') return Promise.resolve(null);
        return Promise.resolve(null);
      },
      transformCallback: (cb: (arg: unknown) => void, once?: boolean) => {
        const id = nextId++;
        registry[id] = once
          ? (arg: unknown) => {
              registry[id] = undefined;
              cb(arg);
            }
          : cb;
        return id;
      },
      unregisterCallback: (id: number) => {
        delete registry[id];
      },
      convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
    };
  });
}

export async function readCalls(page: Page): Promise<DesktopCall[]> {
  return page.evaluate(
    () => (window as unknown as { __desktopCalls: DesktopCall[] }).__desktopCalls,
  );
}

/**
 * Push `messages` through a registered callback with the REAL bridge's
 * frame shapes — each `{ message, index: n }`, then a terminal
 * `{ end, index }`. `channelId` is what `transformCallback` returned for
 * the page's Channel (capture it with `captureChannelId`).
 */
export function pushChannelFrames(
  page: Page,
  channelId: number,
  messages: unknown[],
): Promise<void> {
  return page.evaluate(({ id, msgs }) => {
    const registry = (
      window as unknown as { __tauriCallbacks: Record<number, ((arg: unknown) => void) | undefined> }
    ).__tauriCallbacks;
    const cb = registry[id];
    if (!cb) throw new Error(`no callback registered at id ${id}`);
    let n = 0;
    for (const m of msgs) cb({ message: m, index: n++ });
    cb({ end: true, index: n });
  }, { id: channelId, msgs: messages });
}

/**
 * Reads the invoke payloads from `__desktopCalls` and extracts the FIRST
 * Channel-like argument (a number id, or an object carrying one) for
 * `pushChannelFrames`.
 */
export async function captureChannelId(page: Page, cmd: string): Promise<number> {
  return page.evaluate((wanted) => {
    const calls = (window as unknown as { __desktopCalls: DesktopCall[] }).__desktopCalls;
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      if (call.cmd !== wanted || typeof call.payload !== 'object' || call.payload === null) continue;
      for (const value of Object.values(call.payload as Record<string, unknown>)) {
        if (typeof value === 'number') return value;
        if (typeof value === 'object' && value !== null) {
          const v = value as Record<string, unknown>;
          if (typeof v.callbackId === 'number') return v.callbackId;
          if (typeof v.id === 'number') return v.id;
        }
      }
    }
    throw new Error(`no channel argument captured for ${wanted}`);
  }, cmd);
}
