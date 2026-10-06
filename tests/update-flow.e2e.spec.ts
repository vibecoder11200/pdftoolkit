import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/*
 * REAL update-flow e2e against the preview server (the user-requested test).
 *
 * vite preview serves dist/ from disk per request, so a test can "deploy" by
 * rewriting dist/sw.js and calling registration.update() — the browser sees a
 * byte-different worker and runs the real install → waiting → banner →
 * Cập nhật ngay → activation → auto-reload pipeline, end to end.
 *
 * Two scenarios:
 * 1. The staged worker reports a DIFFERENT build commit (rewrite the inlined
 *    BUILD_COMMIT string) → the banner must appear and the button must
 *    actually reload the page (vite-plugin-pwa#789 regression).
 * 2. The staged worker is byte-different but the SAME build (comment appended
 *    — the hard-reload case) → NO banner; the worker is activated silently.
 *
 * Both restore dist/sw.js in finally; playwright runs spec files in parallel,
 * so the mutation window is kept as short as possible.
 */

const SW_PATH = 'dist/sw.js';

async function waitSwControlled(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  await page.waitForFunction(
    async () => {
      if (!navigator.serviceWorker) return false;
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
}

const updateNow = (page: Page) => page.getByTestId('update-reload');
const hasNoBanner = (page: Page) => expect(updateNow(page)).toHaveCount(0);

test('deploy while page open: banner appears, Cập nhật ngay reloads into the new worker', async ({
  page,
}) => {
  const original = readFileSync(SW_PATH, 'utf8');
  await waitSwControlled(page);
  await hasNoBanner(page);

  // "Deploy" a different build: swap the inlined BUILD_COMMIT so the waiting
  // worker reports a version the page does not run.
  const chip = await page.getByTestId('footer-version').textContent();
  const hash = /·\s*([0-9a-f]{7})$/.exec(chip ?? '')?.[1];
  expect(hash, 'footer chip exposes the build commit').toBeTruthy();
  const mutated = original.replaceAll(hash!, 'e2enew1');
  expect(mutated).not.toBe(original);
  writeFileSync(SW_PATH, mutated);
  try {
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await expect(updateNow(page)).toBeVisible({ timeout: 20_000 });

    // The click must land the user on the new worker: applyUpdate owns the
    // reload, so the newest navigation entry becomes type 'reload' and the
    // old JS context (marker included) is gone.
    await page.evaluate(() => {
      (window as unknown as { mark?: string }).mark = 'stale-page';
    });
    await updateNow(page).click();
    // applyUpdate owns the reload: the newest navigation entry becomes type
    // 'reload' and the old JS context (marker included) is gone. Both probes
    // use waitForFunction — it survives the very navigation it detects.
    await page.waitForFunction(
      () =>
        (
          performance.getEntriesByType('navigation').at(-1) as
            | PerformanceNavigationTiming
            | undefined
        )?.type === 'reload',
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      () => (window as unknown as { mark?: string }).mark === undefined,
      undefined,
      { timeout: 15_000 },
    );
    await hasNoBanner(page);
  } finally {
    writeFileSync(SW_PATH, original);
  }
});

test('hard-reload case: byte-different worker with the SAME build → no banner, silent activation', async ({
  page,
}) => {
  const original = readFileSync(SW_PATH, 'utf8');
  await waitSwControlled(page);
  await hasNoBanner(page);

  writeFileSync(SW_PATH, `${original}\n// deploy noise: byte-diff only, same build\n`);
  try {
    await page.evaluate(() => {
      void navigator.serviceWorker.getRegistration().then(async (r) => {
        r?.addEventListener('updatefound', () => {
          (window as unknown as { __updates?: number }).__updates =
            ((window as unknown as { __updates?: number }).__updates ?? 0) + 1;
        });
        await r?.update();
      });
    });
    // Update discovered → install in progress…
    await page.waitForFunction(() => (window as unknown as { __updates?: number }).__updates !== undefined, undefined, {
      timeout: 20_000,
    });
    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return Boolean(reg?.installing || reg?.waiting);
      },
      undefined,
      { timeout: 20_000 },
    );
    // …then fully settled: the same-build worker was activated silently.
    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return Boolean(reg && !reg.installing && !reg.waiting && reg.active);
      },
      undefined,
      { timeout: 20_000 },
    );
    await hasNoBanner(page);
  } finally {
    writeFileSync(SW_PATH, original);
  }
});
