// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../src/i18n';
import { AppUpdateProvider, useAppUpdate } from '../src/hooks/use-app-update';
import { UpdateBanner } from '../src/components/layout/update-banner';

// The virtual module only exists under the PWA plugin's dev/build pipeline —
// swap in a controllable double that records the options object.
const h = vi.hoisted(() => ({
  opts: {} as Record<string, ((...args: unknown[]) => void) | undefined>,
  updateServiceWorker: (async () => undefined) as (reload?: boolean) => Promise<void>,
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (opts?: Record<string, ((...args: unknown[]) => void) | undefined>) => {
    Object.assign(h.opts, opts ?? {});
    return {
      needRefresh: [false, () => undefined] as const,
      offlineReady: [false, () => undefined] as const,
      updateServiceWorker: h.updateServiceWorker,
    };
  },
}));

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  h.opts = {};
  h.updateServiceWorker = vi.fn(async () => undefined);
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // @ts-expect-error test-only removal of the injected mock
  delete navigator.serviceWorker;
});

function mockServiceWorker(waiting: object | null) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: async () => (waiting ? { waiting } : null),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

function Probe() {
  const { hasWaiting } = useAppUpdate();
  return <span data-testid="probe-has-waiting">{String(hasWaiting)}</span>;
}

const renderTree = () =>
  act(async () => {
    root.render(
      <AppUpdateProvider>
        <UpdateBanner />
        <Probe />
      </AppUpdateProvider>,
    );
  });

const banner = () => container.querySelector('[role="status"]');
const probe = () => container.querySelector('[data-testid="probe-has-waiting"]')!.textContent;
const reloadBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="update-reload"]')!;
const laterBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="update-later"]')!;

describe('use-app-update state machine (red-team F2)', () => {
  it('needRefresh shows the banner AND sets hasWaiting; update button calls updateServiceWorker once', async () => {
    // No worker waiting at mount; the `waiting` event arrives (simulated by
    // onNeedRefresh) and by click time the registration has one.
    let waiting: object | null = null;
    mockServiceWorker(null);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => (waiting ? { waiting } : null) },
    });
    await renderTree();
    expect(banner()).toBeNull();
    expect(probe()).toBe('false');
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).not.toBeNull();
    expect(probe()).toBe('true');
    waiting = { postMessage: () => undefined };
    await act(async () => reloadBtn().click());
    expect(h.updateServiceWorker).toHaveBeenCalledTimes(1);
    // Double-click must not double-reload (reload-once guard).
    await act(async () => reloadBtn().click());
    expect(h.updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('dismiss hides the banner but keeps hasWaiting (footer dot survives); refire stays hidden', async () => {
    mockServiceWorker({ postMessage: () => undefined });
    await renderTree();
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).not.toBeNull();
    await act(async () => laterBtn().click());
    expect(banner()).toBeNull();
    expect(probe()).toBe('true');
    // A second update signal in the same session must not re-nag the banner…
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).toBeNull();
    // …while the footer dot source of truth stays lit.
    expect(probe()).toBe('true');
  });

  it('vanished waiting worker → fallback plain reload, NOT updateServiceWorker', async () => {
    // Realistic sequence: the update was announced, another tab claimed it,
    // the registration no longer has a waiting worker at click time.
    let waiting: object | null = { postMessage: () => undefined };
    mockServiceWorker(null);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: async () => (waiting ? { waiting } : null),
      },
    });
    await renderTree();
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).not.toBeNull();
    waiting = null; // gone before the click
    await act(async () => reloadBtn().click());
    expect(h.updateServiceWorker).not.toHaveBeenCalled();
  });

  it('a worker already waiting at mount surfaces the banner without any event', async () => {
    mockServiceWorker({ postMessage: () => undefined });
    await renderTree();
    expect(banner()).not.toBeNull();
    expect(probe()).toBe('true');
  });

  it('no service worker at all → context stays inert, no crash', async () => {
    await renderTree();
    expect(banner()).toBeNull();
    expect(probe()).toBe('false');
  });
});
