/// <reference lib="webworker" />
/*
 * Custom service worker (plan v0.3.0 phase 6a): generateSW → injectManifest.
 * Same runtime behavior as the phase-5 generated SW (the precache-diff gate
 * proves the manifest is byte-identical) but now owned by us, so the share
 * target fetch handler can live here (phase 6b).
 *
 * Invariants (AGENTS.md build-invariants section): do not remove
 * precacheAndRoute/cleanupOutdatedCaches, the NavigationRoute denylist, the
 * SKIP_WAITING listener, or the injection point — vite-plugin-pwa replaces
 * `self.__WB_MANIFEST` with the built manifest at build time.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import type { PrecacheEntry } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheEntry[] };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigation fallback (replaces generateSW's navigateFallback +
// navigateFallbackDenylist): all navigation requests serve the precached
// index.html except API-ish paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api/],
  }),
);

// registerType: 'prompt' — the update banner (use-app-update.tsx) decides when
// to activate the waiting worker; without this listener messageSkipWaiting()
// would hang forever.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
