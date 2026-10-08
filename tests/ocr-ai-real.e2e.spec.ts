import { chromium, expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/*
 * REAL AI OCR e2e (v0.5.0 patch — regression for the "Unsupported pipeline
 * task: image-text-to-text" download bug). OPT-IN: run with REAL_AI=1 on a
 * WebGPU-capable machine — it downloads the REAL ~652MB model from
 * HuggingFace, verifies it, loads it on WebGPU and GENERATES on the real
 * scan fixture. Everything is the production path: no ?ai-mock flag.
 *
 * PERSISTENT profile (test-results/ai-real-profile): mirrors the real user
 * environment — and the first failure chain (hand-test round 2026-10-09)
 * only reproduced in EPHEMERAL contexts, where cache.put of the 321MB
 * decoder shard dies with "Unexpected internal error". With a persistent
 * profile the store also survives across runs: re-runs after a completed
 * download take the verified-marker fast path (zero network).
 *
 * Network fence: the only allowed external hosts are the HuggingFace
 * family (the model origin + its LFS/xet CDN). Anything else external
 * (jsdelivr, unpkg, …) fails the test — the no-CDN invariant must hold on
 * the real path, not just the mock.
 */

test.skip(
  !process.env.REAL_AI && !process.env.DESKTOP_AI,
  'REAL_AI=1 (web flavor) or DESKTOP_AI=1 (desktop flavor at :4181, root base + desktop CSP)',
);

test('REAL AI OCR: download → verify → load (WebGPU) → generate on the scan fixture', async ({
  baseURL,
}) => {
  test.setTimeout(25 * 60_000);
  const desktop = !!process.env.DESKTOP_AI;
  // Desktop flavor: dist-desktop served at the ROOT (base '/'), carrying
  // the DESKTOP CSP — this is what makes the run a desktop-build check
  // (connect-src must allow the HF origin in that CSP string).
  const origin = desktop ? 'http://localhost:4181' : new URL(baseURL!).origin;
  mkdirSync('test-results/ai-real-profile', { recursive: true });
  const context = await chromium.launchPersistentContext('test-results/ai-real-profile', {
    channel: 'chrome', // system Chrome — the WebGPU-proven path from the SPIKE
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const external: string[] = [];
  const allowed = /(^|\.)(huggingface\.co|hf\.co)$/i;
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      // blob: workers (ORT's internal threads) share the page origin.
      if (u.protocol === 'blob:') return;
      if (u.origin !== origin && !allowed.test(u.hostname) && !u.hostname.endsWith('xethub.hf.co')) {
        external.push(req.url());
      }
    } catch {
      /* ignore */
    }
  });

  await page.goto(`${origin}${desktop ? '/' : '/pdftoolkit/'}tools/ocr`);
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/ocr-scan-table.pdf');
  const aiCard = page.locator('label', { hasText: 'AI — GLM-OCR' });
  await expect(aiCard).toBeVisible({ timeout: 30_000 });
  // The capability gate must NOT disable the engine on this WebGPU machine.
  await expect(aiCard).not.toHaveClass(/opacity-60/);
  await aiCard.locator('input[type="radio"]').check();

  await page.getByRole('button', { name: /Tải model và nhận dạng|Download model/i }).click();

  // REGRESSION (v0.5.0): the old downloadInfo called
  // ModelRegistry.get_pipeline_files('image-text-to-text'), which threw
  // "Unsupported pipeline task" before a single byte downloaded. The fix
  // reads the pinned manifest instead — so the REAL progress UI must now
  // appear (skip on the verified-marker fast path, where the run may jump
  // straight to loading/pages).
  const downloading = page.getByText(/Đang tải model AI… \d+%/).first();
  try {
    await downloading.waitFor({ state: 'visible', timeout: 60_000 });
  } catch {
    /* fast path: model already verified in the persistent store */
  }

  // 652MB down + sha256 verify + WebGPU session load + 2 pages (~50s each
  // on the reference iGPU). 20 minutes is the generous ceiling.
  await expect(page.getByTestId('ai-markdown')).toBeVisible({ timeout: 20 * 60_000 });

  const md = page.getByTestId('ai-markdown');
  // Exact table values from the fixture (SPIKE-verified: the engine reads
  // these correctly, including the skewed page 2).
  await expect(md).toContainText('BT-031');
  await expect(md).toContainText('12.450.000');

  // page 2 (skewed 0.9° + noise) via the Text tab
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByTestId('ai-text')).toContainText('KHSI-002');

  // No non-HF external request happened anywhere in the real flow.
  expect(external).toEqual([]);

  await context.close();
});
