/*
 * PWA share-target landing pad (plan v0.3.0 phase 6b).
 *
 * The Android share sheet POSTs the shared files to ./share-target; the
 * service worker intercepts that navigation, answers 303 → /?share-target=1
 * and parks the files until THIS page signals ready (two-way handshake —
 * the client mounts long after the SW already holds the files, so a SW-initiated
 * postMessage alone races and drops).
 *
 * Security posture (red-team F8/F9): the message listener sits on
 * `navigator.serviceWorker` — NEVER `window`, where any same-origin page on
 * the shared github.io origin could spoof it — and the sender must be a
 * ServiceWorker with a same-origin scriptURL. Files still flow through the
 * standard handoff → buildSuggestions intake (magic bytes, size), so a
 * malicious share has the same trust level as a drag-drop.
 *
 * Accepted limitation (F4.4): a share always lands on home (the 303 target);
 * an in-progress tool session in another tab stays untouched.
 */
import { appendPendingFiles } from './handoff';

const SHARE_PARAM = 'share-target';
const READY = { type: 'SHARE_TARGET_READY' } as const;

let initialized = false;

/**
 * Idempotent: safe under StrictMode's double-invoked effects (the second call
 * is a no-op — the module-level listener must survive remounts, or the SW's
 * reply to the first READY would be dropped mid-handshake).
 */
export function initShareTarget(): void {
  if (initialized) return;
  if (!('serviceWorker' in navigator)) return;
  initialized = true;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const sw = event.source;
    if (!(sw instanceof ServiceWorker)) return;
    if (new URL(sw.scriptURL).origin !== location.origin) return;
    const data = event.data as { type?: string; files?: File[] } | null;
    if (data?.type !== 'SHARE_TARGET_FILES') return;
    if (!Array.isArray(data.files) || data.files.length === 0) return;
    appendPendingFiles(data.files);
  });

  cleanShareParam();
  signalReady();
}

function cleanShareParam(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has(SHARE_PARAM)) return;
  url.searchParams.delete(SHARE_PARAM);
  history.replaceState(null, '', url.href);
}

function signalReady(): void {
  const sw = navigator.serviceWorker.controller;
  if (sw) {
    sw.postMessage(READY);
    return;
  }
  // First visit race: the redirecting SW may not control this client yet.
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => navigator.serviceWorker.controller?.postMessage(READY),
    { once: true },
  );
}
