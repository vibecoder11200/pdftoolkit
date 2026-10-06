import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/*
 * Offline resilience on the custom (injectManifest) SW — plan v0.3.0 phase 6a.
 *
 * smoke.e2e.spec.ts covers offline reload of the home route only. These two
 * cover the migration's riskier parity surface: (a) navigateFallback on a
 * lazy tool deep-link, and (b) a stable-filename precache hit with the pinned
 * revision (assets/qpdf.wasm). If someone breaks precacheAndRoute, the
 * NavigationRoute denylist or the manifestTransforms pins in vite.config.ts,
 * one of these goes red.
 */

async function waitForSwControlled(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    async () => {
      if (!navigator.serviceWorker) return false;
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    },
    undefined,
    { timeout: 20_000 },
  );
  // The first page load is not controlled; a reload attaches the controller.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
}

test('offline deep-link reload serves the lazy sign tool from the precache', async ({
  page,
  context,
}) => {
  await page.goto('./tools/sign');
  await page.getByRole('button', { name: 'Đặt ký và tải xuống' }).waitFor({ timeout: 30_000 });
  await waitForSwControlled(page);
  await context.setOffline(true);
  try {
    await page.reload();
    // NavigationRoute must answer with the precached index.html and the app
    // must boot fully (lazy sign chunk is precached too).
    await expect(page.getByRole('button', { name: 'Đặt ký và tải xuống' })).toBeVisible({
      timeout: 15_000,
    });
    expect(new URL(page.url()).pathname).toMatch(/\/tools\/sign\/?$/);
  } finally {
    await context.setOffline(false);
  }
});

test('offline cache hit: assets/qpdf.wasm is stored with its pinned sha256 revision', async ({
  page,
  context,
}) => {
  const wasm = readFileSync('node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
  const expectedRevision = createHash('sha256').update(wasm).digest('hex');
  await page.goto('./');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  await waitForSwControlled(page);
  await context.setOffline(true);
  try {
    // Workbox stores revisioned stable-filename entries under a mutated cache
    // key (`…?__WB_REVISION__=<hash>`), so a plain caches.match(url) misses it.
    // Find the entry by URL prefix and assert the live pin directly.
    const hit = await page.evaluate(async (prefixUrl) => {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          if (!req.url.startsWith(prefixUrl)) continue;
          const res = await cache.match(req);
          return {
            cacheName: name,
            revision: new URL(req.url).searchParams.get('__WB_REVISION__'),
            status: res ? res.status : 0,
          };
        }
      }
      return null;
    }, new URL('assets/qpdf.wasm', (await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toString()).href);
    expect(hit, 'qpdf.wasm must be present in a precache cache').not.toBeNull();
    expect(hit!.revision).toBe(expectedRevision);
    expect(hit!.status).toBe(200);
    expect(hit!.cacheName).toContain('precache');
  } finally {
    await context.setOffline(false);
  }
});
