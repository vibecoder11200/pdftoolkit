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

interface ServiceWorkerFake {
  getRegistration: () => Promise<{ waiting: WaitingFake } | null>;
  addEventListener: (type: string, cb: (e: unknown) => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  fireControllerChange: () => void;
  fireMessage: (data: unknown, source: unknown) => void;
  setWaiting: (waiting: WaitingFake | null) => void;
}

function mockServiceWorker(initialWaiting: WaitingFake | null): ServiceWorkerFake {
  const listeners = new Map<string, Set<(arg: unknown) => void>>();
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
      for (const cb of [...(listeners.get('controllerchange') ?? [])]) cb(undefined);
    },
    fireMessage: (data, source) => {
      for (const cb of [...(listeners.get('message') ?? [])]) cb({ data, source });
    },
    setWaiting: (waiting) => {
      current = waiting;
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
  return sw;
}

function makeWaiting(
  sw: ServiceWorkerFake,
  opts: { commit?: string | null; silent?: boolean } = {},
): WaitingFake {
  const listeners = new Set<(e: unknown) => void>();
  const waiting: WaitingFake = {
    state: 'installed',
    postMessage: vi.fn((data: { type?: string }) => {
      if (data?.type === 'REQUEST_BUILD_COMMIT' && !opts.silent) {
        // A waiting worker built with the handshake answers from sw.ts.
        queueMicrotask(() =>
          sw.fireMessage({ type: 'BUILD_COMMIT', commit: opts.commit ?? null }, waiting),
        );
      }
    }),
    addEventListener: (_type, cb) => listeners.add(cb),
    activate: () => {
      waiting.state = 'activated';
      for (const cb of [...listeners]) cb({ target: waiting });
    },
  };
  return waiting;
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
  vi.useRealTimers();
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

describe('use-app-update state machine (red-team F2 + vite-plugin-pwa#789)', () => {
  it('different-commit waiting worker: banner shows; click posts SKIP_WAITING and reloads on activation', async () => {
    const sw = mockServiceWorker(null); // nothing waiting when the page loads
    const waiting = makeWaiting(sw, { commit: 'e2enext00' }); // a genuinely newer build
    await renderTree();
    expect(banner()).toBeNull();
    await act(async () => h.opts.onNeedRefresh?.());
    // The handshake resolved with a DIFFERENT commit → banner.
    expect(banner()).not.toBeNull();
    expect(probe()).toBe('true');
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

  it('same-commit waiting worker (hard-reload case): NO banner, silent activation', async () => {
    const sw = mockServiceWorker(null);
    const waiting = makeWaiting(sw, { commit: __COMMIT_HASH__ }); // staged build == page build
    await renderTree();
    expect(banner()).toBeNull();
    // Mid-session install: the waiting event fires with the worker present.
    sw.setWaiting(waiting);
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).toBeNull();
    expect(probe()).toBe('false');
    // Activated silently instead of nagging the user.
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('worker already waiting at mount with a different commit: banner + click works (stale-page case)', async () => {
    const sw = mockServiceWorker(null);
    const waiting = makeWaiting(sw, { commit: 'olderpage' });
    sw.setWaiting(waiting);
    await renderTree();
    expect(banner()).not.toBeNull();
    expect(probe()).toBe('true');
    await act(async () => reloadBtn().click());
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    await act(async () => waiting.activate());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('worker already waiting at mount with the SAME commit: no banner, silent activation', async () => {
    const sw = mockServiceWorker(null);
    const waiting = makeWaiting(sw, { commit: __COMMIT_HASH__ });
    sw.setWaiting(waiting);
    await renderTree();
    expect(banner()).toBeNull();
    expect(probe()).toBe('false');
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('unanswerable worker (pre-handshake build): conservative banner after the timeout', async () => {
    vi.useFakeTimers();
    const sw = mockServiceWorker(null);
    const waiting = makeWaiting(sw, { silent: true }); // never replies
    sw.setWaiting(waiting);
    await renderTree();
    expect(banner()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(banner()).not.toBeNull();
    expect(probe()).toBe('true');
  });

  it('controllerchange alone (clientsClaim path) reloads without waiting for the timer', async () => {
    const sw = mockServiceWorker(null);
    const waiting = makeWaiting(sw, { commit: 'e2enext00' });
    await renderTree();
    await act(async () => h.opts.onNeedRefresh?.());
    sw.setWaiting(waiting);
    await act(async () => reloadBtn().click());
    await act(async () => sw.fireControllerChange());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('dismiss hides the banner but keeps hasWaiting (footer dot survives); refire stays hidden', async () => {
    const sw = mockServiceWorker(null);
    const waiting = makeWaiting(sw, { commit: 'e2enext00' });
    sw.setWaiting(waiting);
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

  it('vanished waiting worker → fallback plain reload, no SKIP_WAITING', async () => {
    const sw = mockServiceWorker(null);
    const waiting = makeWaiting(sw, { commit: 'e2enext00' });
    sw.setWaiting(waiting);
    await renderTree();
    await act(async () => h.opts.onNeedRefresh?.());
    expect(banner()).not.toBeNull();
    sw.setWaiting(null); // another tab took the update before the click
    await act(async () => reloadBtn().click());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(waiting.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('no service worker at all → context stays inert, no crash', async () => {
    await renderTree();
    expect(banner()).toBeNull();
    expect(probe()).toBe('false');
  });
});
