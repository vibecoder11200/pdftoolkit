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
import { clientsClaim } from 'workbox-core';
import type { PrecacheEntry } from 'workbox-precaching';
import { MAX_FILE_BYTES } from './lib/file-accept';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheEntry[] };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// Parity with the generateSW template (which ships clientsClaim by default):
// on activation, claim every open client. Without it a page left
// controller-less by a hard reload never fires controllerchange when the
// waiting worker activates, and the update banner's reload would depend on
// its stall timer (vite-plugin-pwa#789).
clientsClaim();

// SPA navigation fallback (replaces generateSW's navigateFallback +
// navigateFallbackDenylist): all navigation requests serve the precached
// index.html except API-ish paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api/],
  }),
);

// ---- Android share target (plan v0.3.0 phase 6b) --------------------------
// The share sheet POSTs files to ./share-target as a NAVIGATION. We answer
// 303 → /?share-target=1 and park the files until the landing page signals
// SHARE_TARGET_READY (it mounts long after the SW already holds the files).
// Defense-in-depth: oversized files are dropped HERE, before postMessage —
// the client-side buildSuggestions intake re-checks everything anyway.

interface ShareBatch {
  files: File[];
  at: number;
}
const SHARE_QUEUE_MAX = 5;
const SHARE_BATCH_TTL_MS = 10 * 60 * 1000;
const shareQueue: ShareBatch[] = [];
// Client ids that posted SHARE_TARGET_READY — the only ones a flush may
// target. matchAll() alone is not enough: it returns the redirected
// navigation before its JS runs, and a message posted that early is dropped.
const readyClients = new Set<string>();

function scopePathname(): string {
  return new URL(self.registration.scope).pathname;
}

/** Sender must live inside this registration's scope on our origin. */
function isAppClient(client: Client): boolean {
  try {
    const url = new URL(client.url);
    return (
      url.origin === new URL(self.registration.scope).origin &&
      url.pathname.startsWith(scopePathname())
    );
  } catch {
    return false;
  }
}

function enqueueShareFiles(files: File[]): void {
  const now = Date.now();
  while (shareQueue.length > 0 && now - shareQueue[0].at > SHARE_BATCH_TTL_MS) shareQueue.shift();
  shareQueue.push({ files, at: now });
  while (shareQueue.length > SHARE_QUEUE_MAX) shareQueue.shift();
}

async function flushShareQueue(client: Client): Promise<void> {
  while (shareQueue.length > 0) {
    const batch = shareQueue.shift()!;
    client.postMessage({ type: 'SHARE_TARGET_FILES', files: batch.files });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST') return;
  if (event.request.mode !== 'navigate') return; // share-sheet POST is top-level; blocks foreign form-POSTs
  if (!url.pathname.endsWith('/share-target')) return;

  event.respondWith(Response.redirect(new URL('?share-target=1', self.registration.scope).href, 303));
  event.waitUntil(
    (async () => {
      try {
        const form = await event.request.formData();
        const files = [...form.getAll('files')].filter(
          (v): v is File => v instanceof File && v.size <= MAX_FILE_BYTES,
        );
        if (files.length === 0) return;
        enqueueShareFiles(files);
        // Fast path: a landing client that already registered (READY) and is
        // still open gets the files immediately; fresh landings go through
        // the READY handshake below.
        const targets = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const landing = targets.find(
          (c) => readyClients.has(c.id) && new URL(c.url).searchParams.has('share-target'),
        );
        if (landing) await flushShareQueue(landing);
      } catch {
        /* malformed multipart body — nothing to hand off */
      }
    })(),
  );
});

// registerType: 'prompt' — the update banner (use-app-update.tsx) decides when
// to activate the waiting worker; without this listener messageSkipWaiting()
// would hang forever.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (e.data?.type === 'SHARE_TARGET_READY') {
    const sender = e.source as Client | null;
    // Registration-scoped postMessage works from ANY same-origin page (the
    // whole github.io user space shares this origin) — without the scope
    // check, a foreign sibling page could pull parked shared files.
    if (!sender || !isAppClient(sender)) return;
    readyClients.add(sender.id);
    // Prune ids whose clients are gone so the set cannot grow unbounded.
    void self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      const live = new Set(all.map((c) => c.id));
      for (const id of readyClients) if (!live.has(id)) readyClients.delete(id);
      if (live.has(sender.id)) void flushShareQueue(sender);
    });
  }
});
