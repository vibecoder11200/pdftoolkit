import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/*
 * AI OCR e2e (v0.5.0 phase 4a+4b) — the FULL flow runs in the REAL worker
 * chunk through the mock seam (worker spawned with name 'ai-mock' via the
 * ?ai-mock=1 page flag; F8). The zero-external fence is UNCONDITIONAL: the
 * mock must issue zero network requests, so every non-same-origin request
 * collected during the whole run fails the test. The mock's canned output
 * carries adversarial glyph text (`<script>`, onerror, javascript: href),
 * so the export asserts pin the D10 escape-then-format contract end-to-end.
 */

const FIXTURE = 'tests/fixtures/fixture-small.pdf';

function sameOriginAsPage(page: Page, url: string): boolean {
  try {
    return new URL(url).origin === new URL(page.url()).origin;
  } catch {
    return false;
  }
}

test('AI mock full-flow: selector → fake download progress → run → tabs → adversarial-safe exports', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('./tools/ocr?ai-mock=1');
  await page.setInputFiles('input[type="file"]', FIXTURE);

  // Fence: collect EVERY request from here through the whole flow.
  const external: string[] = [];
  page.on('request', (req) => {
    if (!sameOriginAsPage(page, req.url())) external.push(req.url());
  });

  // engine selector (config step): AI card present with tier + state label
  const aiCard = page.locator('label', { hasText: 'AI — GLM-OCR' });
  await expect(aiCard).toBeVisible({ timeout: 20_000 });
  await aiCard.locator('input[type="radio"]').check();

  await page.getByRole('button', { name: /Tải model và nhận dạng|Download model/i }).click();

  // the mock streams its fake download in ~200ms and each page takes ~30ms —
  // the transient progress phases are orchestrator-unit territory; here we
  // pin the END state (download progress UI timing would be flaky).
  await expect(page.getByTestId('ai-markdown')).toBeVisible({ timeout: 30_000 });

  // markdown tab: canned table + heading
  const md = page.getByTestId('ai-markdown');
  await expect(md).toContainText('# BÁO CÁO TỒN KHO QUÝ 3/2026');
  await expect(md).toContainText('| Mã hàng | Thành tiền (VND) |');

  // text tab shows the RAW engine output (adversarial glyphs visible as text)
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByTestId('ai-text')).toContainText('<script>alert(1)</script>');

  // html preview: sandboxed iframe WITHOUT allow-scripts
  await page.getByRole('tab', { name: 'Xem trước HTML' }).click();
  const frame = page.getByTestId('ai-html-preview');
  await expect(frame).toBeVisible();
  const sandbox = await frame.getAttribute('sandbox');
  expect(sandbox).not.toContain('allow-scripts');
  const frameHandle = await frame.elementHandle();
  const srcDoc = await frameHandle?.evaluate((el) => el.getAttribute('srcdoc'));
  expect(srcDoc).not.toMatch(/<script\b/i);
  expect(srcDoc).toContain('&lt;script&gt;alert(1)');
  expect(srcDoc).not.toMatch(/href="javascript:/i);

  // export the .md — glyph text must be preserved as TEXT
  const [mdDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Tải .md' }).click(),
  ]);
  const mdPath = await mdDownload.path();
  const mdFile = readFileSync(mdPath!, 'utf8');
  expect(mdFile).toContain('# BÁO CÁO TỒN KHO QUÝ 3/2026');
  expect(mdFile).toContain('alert(1)');

  // export the .html — the executable surface: NOTHING dangerous unescaped
  const [htmlDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Tải .html' }).click(),
  ]);
  const htmlFile = readFileSync((await htmlDownload.path())!, 'utf8');
  expect(htmlFile).not.toMatch(/<script\b/i);
  expect(htmlFile).not.toMatch(/<(iframe|img)\b/i);
  expect(htmlFile).not.toMatch(/href="javascript:/i);
  expect(htmlFile).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

  // UNCONDITIONAL zero-external fence (F8/R14): the mock run issued nothing.
  expect(external).toEqual([]);
});
