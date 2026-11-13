import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * Phase-8 diagnostics golden (web): a structurally broken PDF reports
 * unreadable and repair REFUSES with no download; a healthy PDF repairs
 * and delivers exactly one "-sua-chua.pdf" through the phase-3 dispatch.
 */

const FIX = join('tests/fixtures/fixture-small.pdf');

function brokenBuffer(): Buffer {
  const s = readFileSync(FIX).toString('latin1');
  const i = s.lastIndexOf('startxref');
  const j = s.indexOf('\n', i);
  const k = s.indexOf('\n', j + 1);
  return Buffer.from(s.slice(0, j + 1) + '99999999' + s.slice(k), 'latin1');
}

test('diagnostics: broken input reports unreadable and repair refuses (no download)', async ({ page }) => {
  test.setTimeout(180_000);
  let sawDownload = false;
  page.on('download', () => {
    sawDownload = true;
  });
  await page.goto('./tools/diagnostics');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'hong.pdf',
    mimeType: 'application/pdf',
    buffer: brokenBuffer(),
  });
  await page.getByTestId('diag-run').click();
  // pdf.js is tolerant (opens the damaged file) — the qpdf leg catches it
  await expect(page.getByTestId('diag-report')).toContainText('qpdf exit: 2', { timeout: 60_000 });
  await page.getByTestId('diag-repair').click();
  // typed refusal surfaces through the shared ErrorBanner (text-danger)
  await expect(page.locator('p.font-bold.text-danger').first()).toBeVisible({ timeout: 60_000 });
  expect(sawDownload).toBe(false);
});

test('diagnostics: healthy input repairs and delivers -sua-chua.pdf once', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('./tools/diagnostics');
  const dl = page.waitForEvent('download', { timeout: 90_000 });
  await page.locator('input[type="file"]').first().setInputFiles(FIX);
  await page.getByTestId('diag-run').click();
  await expect(page.getByTestId('diag-readable')).toContainText('có', { timeout: 60_000 });
  await page.getByTestId('diag-repair').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('fixture-small-sua-chua.pdf');
});
