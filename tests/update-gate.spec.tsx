// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registerSW = vi.hoisted(() =>
  vi.fn((options?: Record<string, unknown>) => {
    void options;
    return Promise.resolve(() => Promise.resolve());
  }),
);
vi.mock('virtual:pwa-register', () => ({ registerSW }));

import { AppUpdateProvider } from '../src/hooks/use-app-update';

/*
 * Phase 1 (D6): inside the Tauri webview the service worker must never
 * register — desktop updates belong to the Tauri updater. The gate reads
 * __TAURI_INTERNALS__ live at effect time, so the same render tree must
 * register on the web and stay inert under the Tauri global.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = '__TAURI_INTERNALS__';
const globals = globalThis as Record<string, unknown>;

describe('AppUpdateProvider SW registration gate', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const mount = async () => {
    const el = document.createElement('div');
    container = el;
    document.body.appendChild(el);
    await act(async () => {
      const r = createRoot(el);
      root = r;
      r.render(createElement(AppUpdateProvider, null, null));
    });
  };

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    delete globals[KEY];
  });

  it('registers the service worker on the web (immediate)', async () => {
    const before = registerSW.mock.calls.length;
    await mount();
    expect(registerSW.mock.calls.length).toBe(before + 1);
    expect(registerSW.mock.calls.at(-1)?.[0]).toMatchObject({ immediate: true });
  });

  it('never registers inside Tauri', async () => {
    globals[KEY] = {};
    const before = registerSW.mock.calls.length;
    await mount();
    expect(registerSW.mock.calls.length).toBe(before);
  });
});
