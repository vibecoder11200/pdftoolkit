// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../src/i18n';
import { AppUpdateProvider, useAppUpdate } from '../src/hooks/use-app-update';
import { UpdateBanner } from '../src/components/layout/update-banner';

// The virtual module only exists under the PWA plugin's dev/build pipeline —
// swap in a double. applyUpdate deliberately does NOT use the plugin's
// updateServiceWorker (vite-plugin-pwa#789: its reload path is unreliable when
// the waiting worker predates the page load or the page is uncontrolled), so
// the hook only consumes the event callbacks.
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (opts?: Record<string, ((...args: unknown[]) => void) | undefined>) => {
    Object.assign(h.opts, opts ?? {});
    return {
      needRefresh: [false, () => undefined] as const,
      offlineReady: [false, () => undefined] as const,
    };
  },
}));

const h = vi.hoisted(() => ({
  opts: {} as Record<string, ((...args: unknown[]) => void) | undefined>,
}));

interface WaitingFake {
  state: string;
  postMessage: Mock;
  addEventListener: (type: string, cb: (e: unknown) => void) => void;
  activate: () => void;
}

function makeWaiting(state = 'installed'): WaitingFake {
  const listeners = new Set<(e: unknown) => void>();
  const waiting: WaitingFake = {
    state,
    postMessage: vi.fn(),
    addEventListener: (_type, cb) => listeners.add(cb),
    activate: () => {
      waiting.state = 'activated';
      for (const cb of [...listeners]) cb({ target: waiting });
    },
  };
  return waiting;
}

interface ServiceWorkerFake {
  getRegistration: () => Promise<{ waiting: WaitingFake } | null>;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  fireControllerChange: () => void;
  setWaiting: (waiting: WaitingFake | null) => void;
}

function mockServiceWorker(initialWaiting: WaitingFake | null): ServiceWorkerFake {
  const listeners = new Map<string, Set<() => void>>();
  let current: WaitingFake | null = initialWaiting;
  const sw: ServiceWorkerFake = {
    getRegistration: async () => (current ? { waiting: current } : null),
    addEventListener: (type, cb) => {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener: (type, cb) => {
      listeners.get(type)?.delete(cb);
    },
    fireControllerChange: () => {
      for (const cb of [...(listeners.get('controllerchange') ?? [])]) cb();
    },
    setWaiting: (waiting) => {
      current = waiting;
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
  return sw;
}

let container: HTMLElement;
let root: Root;
let reload: Mock;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  h.opts = {};
  reload = vi.fn();
  Reflect.deleteProperty(window, 'location');
  Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
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
  it('needRefresh shows the banner; click posts SKIP_WAITING directly and reloads on activation', async () => {
    const waiting = makeWaiting();
    const sw = mockServiceWorker(null); // nothing waiting when the page loads
    await renderTree();
    expect(banner()).toBeNull();
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).not.toBeNull();
    expect(probe()).toBe('true');
    // By click time the registration reports a waiting worker.
    sw.setWaiting(waiting);

    await act(async () => reloadBtn().click());
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled(); // only after the worker activates

    // Either activation signal reloads exactly once…
    await act(async () => waiting.activate());
    expect(reload).toHaveBeenCalledTimes(1);
    // …and whichever fires second is a no-op, as is a double-click.
    await act(async () => sw.fireControllerChange());
    await act(async () => reloadBtn().click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('controllerchange alone (clientsClaim path) reloads without waiting for the timer', async () => {
    const waiting = makeWaiting();
    const sw = mockServiceWorker(waiting);
    await renderTree();
    await act(async () => h.opts.onNeedRefresh?.());
    await act(async () => reloadBtn().click());
    await act(async () => sw.fireControllerChange());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('dismiss hides the banner but keeps hasWaiting (footer dot survives); refire stays hidden', async () => {
    mockServiceWorker(makeWaiting());
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

  it('vanished waiting worker → fallback plain reload, no postMessage', async () => {
    // Realistic sequence: the update was announced, another tab claimed it,
    // the registration no longer has a waiting worker at click time.
    const waiting = makeWaiting();
    const sw = mockServiceWorker(waiting);
    await renderTree();
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).not.toBeNull();
    sw.setWaiting(null); // gone before the click
    await act(async () => reloadBtn().click());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(waiting.postMessage).not.toHaveBeenCalled();
  });

  it('a worker already waiting at mount surfaces the banner and the click still works (hard-reload case)', async () => {
    // The v0.2.1→v0.3.0 bootstrap: the worker installed while the page was
    // loading, so the plugin's `waiting` event never fired in-session — the
    // banner comes from the boot check, and applyUpdate must still work.
    const waiting = makeWaiting();
    mockServiceWorker(waiting);
    await renderTree();
    expect(banner()).not.toBeNull();
    expect(probe()).toBe('true');
    await act(async () => reloadBtn().click());
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    await act(async () => waiting.activate());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('no service worker at all → context stays inert, no crash', async () => {
    await renderTree();
    expect(banner()).toBeNull();
    expect(probe()).toBe('false');
  });
});
