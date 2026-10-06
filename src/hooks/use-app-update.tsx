import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

interface AppUpdateState {
  /** A new service worker is waiting (or arrived externally) — footer dot. */
  hasWaiting: boolean;
  /** hasWaiting and not dismissed this session — drives the banner. */
  bannerVisible: boolean;
  /** "Cập nhật ngay": activate the waiting worker and reload into it. */
  applyUpdate: () => void;
  /** "Để sau": hide the banner for the rest of this page session; the footer
   * dot keeps following hasWaiting. */
  dismiss: () => void;
}

const noop = () => undefined;

const AppUpdateContext = createContext<AppUpdateState>({
  hasWaiting: false,
  bannerVisible: false,
  applyUpdate: noop,
  dismiss: noop,
});

/*
 * Single point of contact with the service worker lifecycle: RootLayout
 * mounts exactly one provider (a second useRegisterSW would register a
 * second Workbox and double-fire controlling listeners), and both the
 * UpdateBanner and the per-page Footer read from this context.
 *
 * State model (red-team F2): hasWaiting is set on EVERY need-refresh signal
 * and never un-set — the footer dot must not starve when the banner is
 * dismissed. bannerVisible = hasWaiting && !dismissed.
 */
export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [hasWaiting, setHasWaiting] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(false);
  const dismissedRef = useRef(false);
  const reloadStartedRef = useRef(false);
  const cleanupChecksRef = useRef<() => void>(noop);

  // NOTE: the plugin's updateServiceWorker is deliberately NOT used (see
  // applyUpdate) — only its event callbacks matter here.
  useRegisterSW({
    onNeedRefresh() {
      setHasWaiting(true);
      if (!dismissedRef.current) setBannerVisible(true);
    },
    onRegisteredSW(swUrl, registration) {
      if (!registration) return;
      // Periodic re-check (1h) + tab-focus re-check. Skipped while an update
      // is already installing or the browser is offline; the probe avoids
      // burning an update() round-trip against a cached/failed sw.js fetch.
      const check = async () => {
        if (!navigator.onLine || registration.installing) return;
        try {
          const probe = await fetch(swUrl, { cache: 'no-store' });
          if (!probe.ok) return;
          await registration.update();
        } catch {
          /* probe failed — offline or blocked; try again next tick */
        }
      };
      const timer = window.setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS);
      const onVisible = () => {
        if (document.visibilityState === 'visible') void check();
      };
      document.addEventListener('visibilitychange', onVisible);
      cleanupChecksRef.current = () => {
        window.clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
    onRegisterError() {
      /* app stays fully usable without the update UI */
    },
  });

  // StrictMode double-mounts the provider in dev: drop the first mount's
  // timers/listeners so checks don't run twice.
  useEffect(() => cleanupChecksRef.current, []);

  // A worker can already be waiting when the page loads (user kept the tab
  // open across a deploy, then reloaded) — surface it without waiting for an
  // event that has already fired.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (reg?.waiting) {
          setHasWaiting(true);
          if (!dismissedRef.current) setBannerVisible(true);
        }
      })
      .catch(() => undefined);
  }, []);

  const applyUpdate = useCallback(() => {
    if (reloadStartedRef.current) return;
    reloadStartedRef.current = true;
    const sw = navigator.serviceWorker;
    const reload = () => window.location.reload();
    void sw
      ?.getRegistration()
      .then((reg) => {
        const waiting = reg?.waiting;
        if (!waiting) {
          // Nothing left to activate — another tab took the update (red-team
          // F2). A plain reload still lands on the newest precache.
          reload();
          return;
        }
        // Own the reload; do NOT route it through the plugin's
        // updateServiceWorker (vite-plugin-pwa#789): its controlling→reload
        // listener is armed only when the `waiting` event fires in-session
        // (missed when the worker predates this page load), `controlling`
        // never fires on an uncontrolled page (hard reload leaves the client
        // controller-less and our SW claims no clients), and workbox's
        // `event.isUpdate` is false when no SW controlled the page at
        // register time. So: postMessage SKIP_WAITING directly and reload on
        // the FIRST of controllerchange / activation / a stall timer.
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          sw.removeEventListener('controllerchange', finish);
          window.clearTimeout(stall);
          reload();
        };
        const onState = (e: Event) => {
          if ((e.target as ServiceWorker).state === 'activated') finish();
        };
        const stall = window.setTimeout(finish, 10_000);
        sw.addEventListener('controllerchange', finish);
        waiting.addEventListener('statechange', onState);
        if (waiting.state === 'activated') finish();
        else waiting.postMessage({ type: 'SKIP_WAITING' });
      })
      .catch(reload);
  }, []);

  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    setBannerVisible(false);
  }, []);

  return (
    <AppUpdateContext.Provider value={{ hasWaiting, bannerVisible, applyUpdate, dismiss }}>
      {children}
    </AppUpdateContext.Provider>
  );
}

export function useAppUpdate(): AppUpdateState {
  return useContext(AppUpdateContext);
}

/*
 * Known heuristic (accepted in the plan): workbox-window classifies a
 * same-session re-registration of a rebuilt SW (dev/canary previews) as an
 * external update, which surfaces as offlineReady instead of needRefresh.
 * Production deploys always arrive in a fresh page load, where `waiting`
 * fires correctly. Workbox 7.x is pinned to match the plugin's transitive
 * copy so the two never drift.
 */
