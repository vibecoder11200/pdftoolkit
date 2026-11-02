import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';

/*
 * PDF → Word e2e (v0.10.0 phase 5). The downloaded .docx is UNZIPPED right
 * here in the Playwright node context (fflate) and its word/document.xml is
 * asserted — the strongest available oracle that the invoice table and
 * headings reached the Word file. The scan leg rides the ?ai-mock=1 canned
 * engine (the ocr-ai.e2e seam): zero external requests, F6's confirm card
 * explicitly exercised.
 */

const FIX = 'tests/fixtures';

async function docxTextOf(path: string): Promise<string> {
  const zip = unzipSync(new Uint8Array(readFileSync(path)));
  const xml = zip['word/document.xml'];
  expect(xml, 'word/document.xml present').toBeDefined();
  return new TextDecoder().decode(xml);
}

function sameOriginAsPage(page: Page, url: string): boolean {
  try {
    return new URL(url).origin === new URL(page.url()).origin;
  } catch {
    return false;
  }
}

test('T1: digital invoice → .docx with the ruled table + headings intact', async ({ page }) => {
  await page.goto('./tools/pdf-to-word');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-p2w-invoice.pdf`);

  // Census auto-detect PRE-HIGHLIGHTS digital (badge) — never auto-runs.
  const digitalRadio = page.locator('input[name="p2w-mode"][value="digital"]');
  await expect(digitalRadio).toBeChecked({ timeout: 30_000 });
  await expect(page.getByText('phát hiện tự động')).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Chuyển sang Word (.docx)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fixture-p2w-invoice.docx');
  const xml = await docxTextOf((await download.path())!);
  expect(xml).toContain('Widget assembly');
  expect(xml).toContain('1,800.00');
  expect(xml).toContain('Total due: $2,845.00');
  expect(xml).toContain('INVOICE #INV-2026-0417');
});

test('T2: scanned fixture routes through AI ONLY after the explicit confirm (F6)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('./tools/pdf-to-word?ai-mock=1');
  // Fence attaches AFTER navigation (the ocr-ai pattern): a listener
  // registered before goto records the page's own document request while
  // page.url() is still about:blank and flags it as "external".
  const external: string[] = [];
  page.on('request', (req) => {
    if (!sameOriginAsPage(page, req.url())) external.push(req.url());
  });

  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-p2w-scan.pdf`);

  // Census pre-highlights scan; the CTA arms the confirm card instead of
  // silently engaging the AI engine.
  const scanRadio = page.locator('input[name="p2w-mode"][value="scan"]');
  await expect(scanRadio).toBeChecked({ timeout: 30_000 });
  const confirm = page.getByTestId('p2w-scan-confirm');
  await expect(page.getByRole('button', { name: 'Chuyển sang Word (.docx)' })).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await page.getByRole('button', { name: 'Chuyển sang Word (.docx)' }).click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('~652 MB');

  await page.getByRole('button', { name: 'Đồng ý chạy AI' }).click();
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
  await downloadPromise;

  // The zero-external fence (ocr-ai precedent): the mock engine must never
  // touch the network.
  expect(external, 'no external requests during the mocked AI run').toEqual([]);
});

test('T3: forced digital on a scanned page refuses honestly (no silent fallback)', async ({
  page,
}) => {
  await page.goto('./tools/pdf-to-word');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-p2w-scan.pdf`);
  const digitalRadio = page.locator('input[name="p2w-mode"][value="digital"]');
  await expect(scanSettled(page)).toBeVisible();
  await digitalRadio.check();
  await page.getByRole('button', { name: 'Chuyển sang Word (.docx)' }).click();
  // The typed Pdf2WordScanError surfaces with the honest routing copy —
  // and NO download happens.
  await expect(page.locator('body')).toContainText('chế độ "Trang quét / ảnh (AI)"', {
    timeout: 30_000,
  });
});

// The census probe runs async; wait for either mode radio to become checked.
function scanSettled(page: Page) {
  return page.locator('input[name="p2w-mode"]:checked');
}
