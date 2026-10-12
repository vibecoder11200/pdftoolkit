import { expect, test, type Page } from '@playwright/test';
import { stubTauri, readCalls } from './helpers/tauri-mock';

/*
 * Fake-sidecar native OCR full flow (v0.6.0 phase 6, R6.2). dist-desktop
 * served at root with `__TAURI_INTERNALS__` mocked via the SHARED helper
 * (registry + real-frame-shape Channels). Zero network: every
 * engine/model/OCR call is a scripted handler; Channel frames ride the
 * byte-compatible `{message,index}` / `{end,index}` shapes.
 *
 * Covers: weak-machine suggestion (IDB-seeded, review F11) → CTA selects
 * native → download frames → run → token counter advances by the SUMMED
 * tokenDelta (review F4) → done view → native Save-As deliver → the
 * benchmark record lands under the 'native' fingerprint (review F2).
 */

const FIXTURE = 'tests/fixtures/fixture-small.pdf';

/** The stateful fake sidecar + weak-machine IDB fixture. */
async function arrange(
  page: Page,
  opts: { statusOverrides?: Record<string, unknown>; seedWeak?: boolean } = {},
) {
  const { statusOverrides = {}, seedWeak = true } = opts;
  await stubTauri(page);
  await page.addInitScript(({ overrides, seedWeak }) => {
    // The REAL Channel instance arrives in the invoke payload (our mock
    // replaces internals.invoke before serialization) — its toJSON() is
    // the bridge wire form "__CHANNEL__:<id>" (String(instance) would give
    // "[object Object]").
    const chId = (v: unknown): number =>
      Number(
        String(
          typeof v === 'string'
            ? v
            : (v as { toJSON?: () => string })?.toJSON?.() ?? v,
        ).split(':')[1],
      );
    const state = {
      engine: false,
      model: false,
      phase: 'stopped',
      backend: 'vulkan',
      cpuFallback: false,
      ocrShouldFail: null as string | null,
      ...overrides,
    };
    const status = () => ({
      phase: state.phase,
      backend: state.backend,
      cpuFallback: state.cpuFallback,
      devices: state.engine ? ['Vulkan1: NVIDIA RTX 3050'] : null,
      enginePresent: state.engine,
      modelPresent: state.model,
      cudaPresent: false,
      sizes: {
        engine: state.engine ? 33_500_000 : 0,
        cuda: 0,
        model: state.model ? 1_400_000_000 : 0,
      },
      lastError: null,
    });
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
      __tauriCallbacks: Record<number, ((f: unknown) => void) | undefined>;
      __fakeSidecar: unknown;
      __releaseOcr: (() => void) | null;
      __holdOcr: boolean;
    };
    w.__fakeSidecar = { state, status };
    w.__holdOcr = false; // opt-in: the full-flow test flips this before start
    w.__tauriSetHandler('native_engine_status', () => status());
    w.__tauriSetHandler('native_engine_probe', () =>
      state.engine ? ['Vulkan1: NVIDIA RTX 3050'] : [],
    );
    w.__tauriSetHandler('native_engine_download', (payload) => {
      const p = payload as { kind: string; onProgress: unknown };
      const cb = w.__tauriCallbacks[chId(p.onProgress)];
      const total = p.kind === 'engine' ? 33_500_000 : 1_400_000_000;
      let n = 0;
      for (; n <= 4; n++) {
        cb?.({ message: { phase: 'downloading', loaded: (total * n) / 4, total, percent: n * 25 }, index: n });
      }
      cb?.({ end: true, index: n });
      if (p.kind === 'engine') state.engine = true;
      else state.model = true;
      return total;
    });
    w.__tauriSetHandler('native_engine_start', () => {
      state.phase = 'ready';
      return status();
    });
    w.__tauriSetHandler('native_cancel', () => undefined);
    w.__tauriSetHandler('native_ocr_page', (payload) => {
      if (state.ocrShouldFail) throw state.ocrShouldFail;
      const p = payload as { onToken: unknown };
      const cb = w.__tauriCallbacks[chId(p.onToken)];
      // Canned VN text: 2 frames, 2 tokens each → the counter must show 4
      // (SUMMED tokenDelta, review F4), never 2 (frame count). Hold before
      // the result so the test can read the RUNNING view's counter.
      cb?.({ message: { delta: '# Trang\n\n', tokenDelta: 2 }, index: 0 });
      cb?.({ message: { delta: 'Xin chào', tokenDelta: 2 }, index: 1 });
      cb?.({ end: true, index: 2 });
      if (w.__holdOcr) {
        return new Promise((resolve) => {
          w.__releaseOcr = () => {
            w.__holdOcr = false; // only the FIRST page holds
            resolve({ text: '# Trang\n\nXin chào', ms: 800, firstTokenMs: 90, genTokens: 4, tokPerSec: 5 });
          };
        });
      }
      return { text: '# Trang\n\nXin chào', ms: 800, firstTokenMs: 90, genTokens: 4, tokPerSec: 5 };
    });
    // Weak machine (review F11 — IndexedDB, NEVER localStorage): a 'wasm'
    // record at 8 tok/s ⇒ tier cpu ⇒ suggestion eligible. seedWeak=false
    // leaves the store empty (the tier-none fixture needs the estimate
    // path, and a matching record would compute 'cpu' instead).
    if (seedWeak) {
      const open = indexedDB.open('pdftoolkit-ai', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('benchmarks'))
          open.result.createObjectStore('benchmarks');
      };
      open.onsuccess = () => {
        const db = open.result;
        db.transaction('benchmarks', 'readwrite')
          .objectStore('benchmarks')
          .put(
            {
              modelId: 'glm-ocr',
              tokPerSecWarm: 8,
              firstTokenColdMs: 900,
              condition: 'wasm',
              measuredAt: Date.now(),
              adapterFingerprint: '?|?|?',
            },
            'benchmark/v2/glm-ocr/?|?|?',
          );
        db.close();
      };
    }
  }, { overrides: statusOverrides, seedWeak });
}

test('weak machine → suggestion → download → native run → Save-As deliver → native benchmark key', async ({
  page,
}) => {
  await arrange(page);
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  // Hold the FIRST page's result so the running view (and its token
  // counter) stays readable.
  await page.evaluate(() => {
    (window as unknown as { __holdOcr: boolean }).__holdOcr = true;
  });
  // The suggestion card (D3 triggers on the seeded 8 tok/s wasm record).
  await expect(page.getByTestId('native-suggest-card')).toBeVisible();
  // CTA selects the native radio.
  await page.getByTestId('native-suggest-use').click();
  await expect(page.getByRole('radio', { name: /AI Native/ })).toBeChecked();
  // Run → mocked downloads (engine then model) → ready → pages.
  await page.getByRole('button', { name: /Tải engine và nhận dạng/ }).click();
  // Token counter advanced by the SUMMED tokenDelta (4), not frames (2) —
  // read in the RUNNING view (the fake holds the first page's result).
  await expect(page.getByText(/4 token/)).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    (window as unknown as { __releaseOcr: (() => void) | null }).__releaseOcr?.();
  });
  // Done view: the canned VN text made it through the SAME junction.
  await expect(page.getByTestId('ai-markdown')).toContainText('Xin chào', { timeout: 20_000 });
  // Benchmark honesty (review F2): the native record exists under its OWN
  // fingerprint key with condition 'native' — saved on the 2nd page.
  const nativeRec = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('pdftoolkit-ai', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rec = await new Promise<unknown>((resolve) => {
      const req = db.transaction('benchmarks').objectStore('benchmarks').get('benchmark/v2/glm-ocr/native');
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return rec;
  });
  expect(nativeRec).toMatchObject({ condition: 'native', tokPerSecWarm: 5 });
  // The weak web record survived engine alternation (same-run read).
  const webRec = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('pdftoolkit-ai', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rec = await new Promise<unknown>((resolve) => {
      const req = db.transaction('benchmarks').objectStore('benchmarks').get('benchmark/v2/glm-ocr/?|?|?');
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return rec;
  });
  expect(webRec).toMatchObject({ condition: 'wasm', tokPerSecWarm: 8 });
  // Deliver goes through the NATIVE save dialog — never a raw download.
  // (The deliver path awaits its dynamic plugin import before invoking.)
  await page.getByRole('button', { name: 'Tải .md' }).click();
  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const cmds = (await readCalls(page)).map((c) => c.cmd);
  expect(cmds).toContain('plugin:fs|write_file');
  // The whole run spoke ONLY to the fake sidecar commands.
  expect(cmds).toContain('native_engine_download');
  expect(cmds).toContain('native_ocr_page');
});

test('tier-none machine: native stays selectable and runnable (review F1 fork guard)', async ({
  page,
}) => {
  // NO benchmark record + NO WebGPU ⇒ aiTierEstimate lands on estimate
  // tier 'none' — the exact machine where the WebGPU verdict must NOT gate
  // native (the phase 4 blanket-propagation trap).
  await arrange(page, { seedWeak: false });
  await page.addInitScript(() => {
    // navigator.gpu is an OWN property of the navigator instance in
    // Chromium — shadowing Navigator.prototype is not enough.
    try {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    } catch {
      delete (navigator as unknown as { gpu?: unknown }).gpu;
    }
  });
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  // The WEB engine is unavailable on this machine — rendered as the
  // opacity-60 treatment on its label (R4.4 :464), never a disabled input.
  const aiOption = page
    .getByRole('radio', { name: /AI — GLM-OCR/ })
    .locator('xpath=ancestor::label[1]');
  await expect(aiOption).toHaveClass(/opacity-60/);
  // …but native is selectable and the run completes.
  await page.getByRole('radio', { name: /AI Native/ }).check();
  await page.getByRole('button', { name: /Tải engine và nhận dạng/ }).click();
  await expect(page.getByTestId('ai-markdown')).toContainText('Xin chào', { timeout: 20_000 });
});

test('cpu-fallback fixture: first-run gate with continue/abort (review F14)', async ({
  page,
}) => {
  await arrange(page, { statusOverrides: { backend: 'cpu', cpuFallback: true } });
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.getByRole('radio', { name: /AI Native/ }).check();
  await page.getByRole('button', { name: /Tải engine và nhận dạng/ }).click();
  // Downloads ran; the gate appears BEFORE any page runs.
  await expect(page.getByTestId('native-cpu-gate')).toBeVisible({ timeout: 20_000 });
  // Abort flips back to the in-app engine (never a silent degrade).
  await page.getByTestId('native-cpu-gate-abort').click();
  await expect(page.getByRole('radio', { name: /AI — GLM-OCR/ })).toBeChecked();
  // Continue proceeds (acknowledged for the session).
  await page.getByRole('radio', { name: /AI Native/ }).check();
  await page.getByRole('button', { name: /Nhận dạng|Tải engine/ }).click();
  await page.getByTestId('native-cpu-gate-continue').click();
  await expect(page.getByTestId('ai-markdown')).toContainText('Xin chào', { timeout: 20_000 });
});

test('engine crash mid-run: resume banner offers page-indexed restart', async ({ page }) => {
  await arrange(page);
  await page.addInitScript(() => {
    (
      window as unknown as { __fakeSidecar: { state: { ocrShouldFail: string | null } } }
    ).__fakeSidecar.state.ocrShouldFail = JSON.stringify({ kind: 'crashed', detail: 'exit 1' });
  });
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.getByRole('radio', { name: /AI Native/ }).check();
  await page.getByRole('button', { name: /Tải engine và nhận dạng/ }).click();
  // The crash classifier (WorkerCrashError subclass) drives the RESUME
  // banner — the crash is restartable, not terminal.
  await expect(page.getByTestId('ai-resume')).toBeVisible({ timeout: 20_000 });
});

test('terminal native error (oom): classified banner + one-click fallback (R4.7)', async ({
  page,
}) => {
  await arrange(page);
  // The download itself fails with the OOM classification — a terminal
  // error (no page ever ran → no resume), so the fallback button shows.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __tauriSetHandler: (c: string, f: (p?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('native_engine_download', () => {
      throw JSON.stringify({ kind: 'oom', detail: null });
    });
  });
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.getByRole('radio', { name: /AI Native/ }).check();
  await page.getByRole('button', { name: /Tải engine và nhận dạng/ }).click();
  await expect(page.getByTestId('ocr-native-fallback')).toBeVisible({ timeout: 20_000 });
  // One-click fallback lands back in config with the in-app engine selected
  // (never a silent switch — the user clicked this).
  await page.getByTestId('ocr-native-fallback').click();
  await expect(page.getByRole('radio', { name: /AI — GLM-OCR/ })).toBeChecked();
});

test('suggestion suppressed for strong machines and after dismissal', async ({ page }) => {
  await stubTauri(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __tauriSetHandler: (c: string, f: (p?: unknown) => unknown) => void };
    const full = {
      phase: 'ready',
      backend: 'vulkan',
      cpuFallback: false,
      devices: ['Vulkan1: NVIDIA RTX 3050'],
      enginePresent: true,
      modelPresent: true,
      cudaPresent: false,
      sizes: { engine: 33_500_000, cuda: 0, model: 1_400_000_000 },
      lastError: null,
    };
    w.__tauriSetHandler('native_engine_status', () => full);
    // Strong machine fixture: a 45 tok/s webgpu record → NOT eligible.
    const open = indexedDB.open('pdftoolkit-ai', 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('benchmarks'))
        open.result.createObjectStore('benchmarks');
    };
    open.onsuccess = () => {
      const db = open.result;
      db.transaction('benchmarks', 'readwrite')
        .objectStore('benchmarks')
        .put(
          {
            modelId: 'glm-ocr',
            tokPerSecWarm: 45,
            firstTokenColdMs: 300,
            condition: 'webgpu',
            measuredAt: Date.now(),
            adapterFingerprint: '?|?|?',
          },
          'benchmark/v2/glm-ocr/?|?|?',
        );
      db.close();
    };
  });
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.getByRole('radio', { name: /AI — GLM-OCR/ })).toBeVisible();
  await expect(page.getByTestId('native-suggest-card')).toHaveCount(0);

  // Weak machine + dismiss → hidden, and stays hidden across a reload.
  await arrange(page);
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.getByTestId('native-suggest-card')).toBeVisible();
  await page.getByTestId('native-suggest-dismiss').click();
  await expect(page.getByTestId('native-suggest-card')).toHaveCount(0);
  await page.reload();
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.getByTestId('native-suggest-card')).toHaveCount(0);
});

test('download cancel invokes native_cancel (the command family rides the same client)', async ({
  page,
}) => {
  await stubTauri(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __tauriSetHandler: (c: string, f: (p?: unknown) => unknown) => void;
      __tauriCallbacks: Record<number, ((f: unknown) => void) | undefined>;
      __releaseDownload: (() => void) | null;
    };
    const state = { engine: false, model: false };
    const status = () => ({
      phase: 'stopped',
      backend: null,
      cpuFallback: null,
      devices: null,
      enginePresent: state.engine,
      modelPresent: state.model,
      cudaPresent: false,
      sizes: { engine: 0, cuda: 0, model: 0 },
      lastError: null,
    });
    w.__tauriSetHandler('native_engine_status', () => status());
    // HOLD the engine download mid-stream: frames flow but the promise
    // never settles until the test releases it — the cancel button stays.
    w.__tauriSetHandler('native_engine_download', (payload) => {
      const p = payload as { kind: string; onProgress: unknown };
      const raw = typeof p.onProgress === 'string' ? p.onProgress : (p.onProgress as { toJSON?: () => string })?.toJSON?.() ?? '';
      const cb = w.__tauriCallbacks[Number(raw.split(':')[1])];
      cb?.({ message: { phase: 'downloading', loaded: 5_000_000, total: 33_500_000, percent: 15 }, index: 0 });
      return new Promise((resolve) => {
        (w as unknown as { __releaseDownload: () => void }).__releaseDownload = () => {
          state.engine = true;
          cb?.({ end: true, index: 1 });
          resolve(33_500_000);
        };
      });
    });
    w.__tauriSetHandler('native_engine_start', () => status());
    w.__tauriSetHandler('native_cancel', () => undefined);
  });
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.getByRole('radio', { name: /AI Native/ }).check();
  await page.getByRole('button', { name: /Tải engine và nhận dạng/ }).click();
  await expect(page.getByTestId('ai-cancel-download')).toBeVisible({ timeout: 20_000 });
  // The held download's frame actually reaches the progress bar (channel
  // id extracted via toJSON — the regression this test originally caught).
  await expect(page.getByText(/15%/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('ai-cancel-download').click();
  // cancelDownload awaits the dynamic @tauri-apps import before the invoke
  // — poll, don't read once.
  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'native_cancel').length;
    }, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const cancelCalls = (await readCalls(page)).filter((c) => c.cmd === 'native_cancel');
  expect(['model', 'engine']).toContain(
    (cancelCalls[0].payload as { kind: string }).kind,
  );
  // Release the held download so the page settles cleanly.
  await page.evaluate(() => {
    (
      window as unknown as { __releaseDownload: (() => void) | null }
    ).__releaseDownload?.();
  });
});
