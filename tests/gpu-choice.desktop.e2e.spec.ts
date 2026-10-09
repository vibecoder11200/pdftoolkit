import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

const MANIFEST = JSON.parse(readFileSync('scripts/ai-model-manifest.json', 'utf8')) as {
  repo: string;
  revision: string;
  files: Array<{ path: string; size: number }>;
};

/*
 * GPU-choice desktop e2e (plan 261009-0836 phase 5, SEC-2): the fake
 * `navigator.gpu` must reach the WORKER global, not just the page —
 * RealEngine probes navigator.gpu inside the dedicated worker (its own
 * global), so `addInitScript` alone never reaches it. The worker chunk is
 * served via route-interception with the fake-gpu script PREPENDED to the
 * chunk body (plus addInitScript for the page-side probes).
 *
 * Everything runs through the mock engine (`?ai-mock=1`): zero model
 * network, and the choice/apply path must be a no-op for the mock engine.
 */

const FIXTURE = 'tests/fixtures/fixture-small.pdf';

/** The fake gpu surface — same script for page and worker globals. */
function fakeGpuScript(mode: 'dual' | 'swiftshader'): string {
  const adapters =
    mode === 'dual'
      ? `const igpu = mk('intel', 'gen-12lp', 'iris-xe', 2 * 1024 ** 3, false);
         const dgpu = mk('nvidia', 'ada', '4050', 8 * 1024 ** 3, false);`
      : `const igpu = mk('Google', 'SwiftShader', 'swiftshader', 4 * 1024 ** 3, true);
         const dgpu = igpu;`;
  return `(() => {
    const mk = (vendor, arch, device, maxBuf, fallback) => ({
      info: { vendor, architecture: arch, device, description: vendor + ' ' + device },
      isFallbackAdapter: fallback,
      limits: { maxBufferSize: maxBuf },
      features: new Set(['shader-f16']),
      requestDevice: async () => ({
        destroy() {},
        lost: Promise.resolve({ reason: 'destroyed', message: '' }),
      }),
    });
    ${adapters}
    const gpu = {
      requestAdapter: async (opts) =>
        !opts || !opts.powerPreference || opts.powerPreference === 'high-performance' ? dgpu : igpu,
    };
    try {
      Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
    } catch {}
  })();`;
}

async function shimWorkerGpu(page: Page, mode: 'dual' | 'swiftshader'): Promise<void> {
  // SEC-2: PREPEND to the worker chunk body — the worker global gets the
  // fake before any app code runs in it. Keep the info accessors plain
  // objects here; the F23 throw-shapes are unit-pinned (gpu-choice.spec).
  await page.route(/\/assets\/ai-ocr\.worker-.*\.js/, async (route: Route) => {
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `${fakeGpuScript(mode)}\n${body}`,
    });
  });
  await page.addInitScript(fakeGpuScript(mode));
}

// Model-cache seeding (settings.e2e pattern): the measure button gates on
// isModelCachedLocally — seed the chunked AI store from the manifest.
const MODEL_CHUNK_BYTES = 64 * 1024 * 1024;
const AI_URLS = MANIFEST.files.map((f) => ({
  url: `https://huggingface.co/${MANIFEST.repo}/resolve/${MANIFEST.revision}/${f.path}`,
  parts: Math.max(1, Math.ceil(f.size / MODEL_CHUNK_BYTES)),
}));

async function seedModelCache(page: Page): Promise<void> {
  await page.evaluate(async (aiUrls) => {
    const ai = await caches.open('pdftoolkit-ai-v1');
    for (const { url, parts } of aiUrls) {
      for (let i = 0; i < parts; i += 1) {
        await ai.put(`${url}::part/${i}`, new Response('seed'));
      }
    }
  }, AI_URLS);
}

test('dual fake adapters: list, apply → status line, diagnostics, per-adapter bench records', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await shimWorkerGpu(page, 'dual');
  await page.goto('./settings?ai-mock=1');
  await seedModelCache(page);
  // The panel computes modelCached at mount — reload so the seeded cache
  // enables the per-adapter measure buttons (settings.e2e pattern).
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // Adapter list: BOTH adapters, high-performance slot first, real labels.
  const list = page.getByTestId('gpu-adapter-list');
  await expect(list).toBeVisible({ timeout: 20_000 });
  const labels = page.getByTestId('gpu-adapter-label');
  await expect(labels).toHaveCount(2);
  await expect(labels.nth(0)).toHaveText(/nvidia · ada · 4050/);
  await expect(labels.nth(1)).toHaveText(/intel · gen-12lp · iris-xe/);

  // Diagnostics: both fingerprints, hp slot = nvidia, lp slot = intel,
  // active request = the auto-resolved nvidia.
  await page.getByTestId('gpu-diagnostics').locator('summary').click();
  const table = page.getByTestId('gpu-diagnostics');
  await expect(table).toContainText('nvidia|ada|4050');
  await expect(table).toContainText('intel|gen-12lp|iris-xe');
  await expect(page.getByTestId('gpu-diag-active')).toContainText('nvidia|ada|4050');

  // Per-adapter measurement (mock engine): a record under B (nvidia) must
  // NOT satisfy A (intel) — the intel row keeps "never measured".
  await page.getByTestId(/^gpu-measure-nvidia/).click();
  await expect(page.getByTestId(/^gpu-bench-nvidia/)).toContainText(
    /token\/(s|giây)|tokens\/s/i,
    { timeout: 60_000 },
  );
  await expect(page.getByTestId(/^gpu-bench-intel/)).toContainText(
    /Chưa đo trên card này|Never measured on this card/,
  );

  // Choose intel + Apply → persists; the OCR status line follows WITHOUT an
  // app restart (fresh navigation, same origin state).
  await page.getByTestId(/^gpu-choice-intel/).check();
  await page.getByTestId('gpu-apply').click();
  await expect(page.getByTestId('gpu-diag-active')).toContainText('intel|gen-12lp|iris-xe', {
    timeout: 20_000,
  });

  await page.goto('./tools/ocr?ai-mock=1');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.locator('label', { hasText: 'AI — GLM-OCR' }).locator('input[type="radio"]').check();
  await expect(page.getByTestId('ocr-gpu-status')).toContainText('intel · gen-12lp · iris-xe', {
    timeout: 20_000,
  });
});

test('swiftshader probe: software adapter grayed, never selectable, single honest row', async ({
  page,
}) => {
  await shimWorkerGpu(page, 'swiftshader');
  await page.goto('./settings?ai-mock=1');

  const list = page.getByTestId('gpu-adapter-list');
  await expect(list).toBeVisible({ timeout: 20_000 });
  // both probes collapsed to the SAME software adapter → exactly ONE row
  await expect(page.getByTestId('gpu-adapter-label')).toHaveCount(1);
  await expect(page.getByTestId('gpu-adapter-label')).toHaveText(/Google · SwiftShader/);
  const row = page.locator('li', { has: page.getByTestId('gpu-adapter-label') });
  await expect(row).toContainText(/adapter phần mềm|software adapter/);
  await expect(page.getByTestId(/^gpu-choice-Google/)).toBeDisabled();
  // measure is software-filtered too
  await expect(page.getByTestId(/^gpu-measure-Google/)).toBeDisabled();
});
