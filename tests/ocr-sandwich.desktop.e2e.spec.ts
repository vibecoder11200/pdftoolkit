import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { stubTauri, readCalls } from './helpers/tauri-mock';

/*
 * Searchable-PDF sandwich e2e (v0.7.0 phase 3, desktop fake sidecar). The
 * native run → done view → "Tải PDF" click-time build → the NATIVE Save-As
 * dialog (never a raw download). Also pins the engine-input independence:
 * with ARCHIVE file quality selected, the native_ocr_page raster is still
 * the AI_DPI 150 render (PNG IHDR width 1240 on the A4 fixture).
 */

const FIXTURE = 'tests/fixtures/fixture-small.pdf';

async function arrange(page: Page): Promise<void> {
  await stubTauri(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    const state = { engine: true, model: true, phase: 'stopped' };
    const status = () => ({
      phase: state.phase,
      backend: 'vulkan',
      cpuFallback: false,
      devices: ['Vulkan1: NVIDIA RTX 3050'],
      enginePresent: state.engine,
      modelPresent: state.model,
      cudaPresent: false,
      sizes: { engine: 33_500_000, cuda: 0, model: 1_400_000_000 },
      lastError: null,
    });
    w.__tauriSetHandler('native_engine_status', () => status());
    w.__tauriSetHandler('native_engine_probe', () => ['Vulkan1: NVIDIA RTX 3050']);
    w.__tauriSetHandler('native_engine_start', () => {
      state.phase = 'ready';
      return status();
    });
    w.__tauriSetHandler('native_cancel', () => undefined);
    w.__tauriSetHandler('native_ocr_page', () => ({
      text: '# Trang\n\nXin chào',
      ms: 800,
      firstTokenMs: 90,
      genTokens: 4,
      tokPerSec: 5,
    }));
  });
}

test('native run with archive quality → Save-As PDF deliver; engine input stays AI_DPI 150', async ({
  page,
}) => {
  await arrange(page);
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.getByRole('radio', { name: /AI Native/ }).check();
  // File quality picked BEFORE the run: the engine input must not care.
  await page.getByTestId('ocr-pdf-quality-archive').click();
  await expect(page.getByTestId('ocr-pdf-quality-archive')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Nhận dạng|Tải engine/ }).click();
  await expect(page.getByTestId('ai-markdown')).toContainText('Xin chào', { timeout: 20_000 });

  // Deliver → the native Save-As dialog carries the -ocr.pdf name; the
  // bytes then go through plugin:fs (never a browser download).
  await page.getByTestId('ai-download-pdf').click();
  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const calls = await readCalls(page);
  const save = calls.find((c) => c.cmd === 'plugin:dialog|save');
  expect(
    (save!.payload as { options?: { defaultPath?: string } }).options?.defaultPath,
  ).toMatch(/-ocr\.pdf$/);
  expect(calls.map((c) => c.cmd)).toContain('plugin:fs|write_file');

  // Engine-input independence: the raster the native engine received is the
  // uncapped AI_DPI=150 PNG (1240 px wide on this A4 fixture), not a
  // 300-DPI archive render.
  const ocrCalls = calls.filter((c) => c.cmd === 'native_ocr_page');
  expect(ocrCalls.length).toBeGreaterThan(0);
  const args = (ocrCalls[0].payload as { args?: { imageDataUrl?: string } }).args ?? {};
  const dataUrl = args.imageDataUrl ?? '';
  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  // PNG IHDR: 8-byte signature + 4 len + 4 type, width at offset 16 (BE).
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 1 + 32);
  const head = Buffer.from(b64, 'base64');
  expect(head.length).toBeGreaterThanOrEqual(20);
  expect(head.readUInt32BE(16)).toBe(1240);
});

test('native run → DOCX deliver via the Save-As dialog (never a raw download)', async ({ page }) => {
  await arrange(page);
  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.getByRole('radio', { name: /AI Native/ }).check();
  await page.getByRole('button', { name: /Nhận dạng|Tải engine/ }).click();
  await expect(page.getByTestId('ai-markdown')).toContainText('Xin chào', { timeout: 20_000 });
  // The build runs in the PDF worker (real docx chunks in dist-desktop);
  // the deliver goes through the native Save-As dialog.
  await page.getByTestId('ai-download-docx').click();
  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const save = (await readCalls(page)).find((c) => c.cmd === 'plugin:dialog|save');
  expect(
    (save!.payload as { options?: { defaultPath?: string } }).options?.defaultPath,
  ).toMatch(/-ocr\.docx$/);
  expect((await readCalls(page)).map((c) => c.cmd)).toContain('plugin:fs|write_file');
});
