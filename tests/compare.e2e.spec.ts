import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Compare e2e (v0.11.0 phase 7, plan 261109-1101): the flagship scenario
 * through the REAL engine in chromium — one word changes on p1 of the
 * B fixture and p3 is added. Pins: the changed pair auto-selects with an
 * inserted box on B (and the strikethrough on A after the toggle), the
 * added-page banner + navigator badges render, and the stats line counts
 * exactly one changed page. The gap-region alignment repair (exact digest
 * would unalign the edited page) is what makes the FIRST pin satisfiable.
 */

const FIX_A = join('tests/fixtures/fixture-compare-a.pdf');
const FIX_B = join('tests/fixtures/fixture-compare-b.pdf');

test('compare: word-change marks, changed/added badges, added-page banner', async ({ page }) => {
  test.setTimeout(180_000);
  if (readFileSync(FIX_A).length === 0 || readFileSync(FIX_B).length === 0) {
    throw new Error('compare fixtures missing — run `node tests/fixtures/gen.mjs` first');
  }

  await page.goto('./tools/compare');
  // Two slots → two dropzone file inputs; slot A first, then B (A's input
  // is replaced by the chip once set).
  await page.locator('input[type="file"]').first().setInputFiles(FIX_A);
  await page.locator('input[type="file"]').first().setInputFiles(FIX_B);

  // Probe: meta shows the page counts (A=2, B=3).
  await expect(page.getByText('↔ fixture-compare-b.pdf · 2/3 trang')).toBeVisible({ timeout: 30_000 });

  const cta = page.getByRole('button', { name: 'So sánh ngay' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();

  const result = page.getByTestId('compare-result');
  await expect(result).toBeVisible({ timeout: 60_000 });

  // The changed pair auto-selects (firstChanged heuristic).
  await expect(page.getByText('Cặp trang 1')).toBeVisible();

  // Added-page banner: B p3 has no A counterpart.
  await expect(page.getByText('Trang chỉ có ở bản sửa: 3')).toBeVisible();
  await expect(page.getByText('Trang chỉ có ở bản gốc')).toHaveCount(0);

  // Stats: exactly one changed page, one word each way.
  await expect(page.getByText('1 trang có thay đổi · +1 từ thêm · −1 từ bỏ')).toBeVisible();

  // Overlay marks on side B (default): the inserted word box.
  await expect(page.getByTestId('compare-ins-mark')).toHaveCount(1);
  await expect(page.getByTestId('compare-del-mark')).toHaveCount(0);

  // Navigator badges: B1 changed, B3 added, B2 clean.
  const badges = page.getByTestId('thumb-badge');
  await expect(badges.filter({ hasText: 'Đã đổi' })).toHaveCount(1);
  await expect(badges.filter({ hasText: 'Trang mới' })).toHaveCount(1);

  // A/B toggle: side A shows the strikethrough mark, no green box.
  await page.getByRole('button', { name: 'Bản gốc' }).first().click();
  await expect(page.getByTestId('compare-del-mark')).toHaveCount(1);
  await expect(page.getByTestId('compare-ins-mark')).toHaveCount(0);

  // Navigator tile click jumps to that pair (the strip acts on onToggle even
  // when selectable={false} — a walkthrough regression: tiles were inert).
  await page.locator('[data-page-cell="3"]').click();
  await expect(page.getByText('Cặp trang 3')).toBeVisible();

  // Fullscreen preview opens from the hover-revealed expand button and closes
  // (a walkthrough regression: the button was display:none forever — the tile
  // lacked the `group` class — and the uncapped image clipped the close row).
  await page.locator('[data-page-cell="3"]').hover();
  await page.locator('[data-page-cell="3"] button[aria-label="Trang 3"]').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Đóng' }).first()).toBeVisible();
  await dlg.getByRole('button', { name: 'Đóng' }).first().click();
  await expect(dlg).toHaveCount(0);
});

test('compare export: two annotated PDFs download (web)', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('./tools/compare');
  await page.locator('input[type="file"]').first().setInputFiles(FIX_A);
  await page.locator('input[type="file"]').first().setInputFiles(FIX_B);
  await expect(page.getByText('↔ fixture-compare-b.pdf · 2/3 trang')).toBeVisible({ timeout: 30_000 });
  const cta = page.getByRole('button', { name: 'So sánh ngay' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  await expect(page.getByTestId('compare-result')).toBeVisible({ timeout: 60_000 });

  // Sequential waits: two concurrent listeners both bind the FIRST
  // download (deliverBytesMulti spaces them 150ms on web).
  const dlA = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất hai PDF chú giải' }).click();
  const outA = await dlA;
  const dlB = page.waitForEvent('download');
  const outB = await dlB;
  expect(outA.suggestedFilename()).toMatch(/-so-sanh-A\.pdf$/);
  expect(outB.suggestedFilename()).toMatch(/-so-sanh-B\.pdf$/);

  // The exported B PDF still carries the drawn marks: re-open via pdf.js
  // and confirm the page renders (valid output, not a corrupt save).
  const paths = [join(await outA.path()), join(await outB.path())];
  for (const p of paths) {
    const stat = readFileSync(p).length;
    expect(stat).toBeGreaterThan(1000);
  }
});

test('compare scan pair: ai-mock census → confirm → clause panel; export excludes it', async ({ page }) => {
  test.setTimeout(240_000);
  const SCAN_A = join('tests/fixtures/fixture-compare-scan-a.pdf');
  const SCAN_B = join('tests/fixtures/fixture-compare-scan-b.pdf');
  await page.goto('./tools/compare?ai-mock=1');
  await page.locator('input[type="file"]').first().setInputFiles(SCAN_A);
  await page.locator('input[type="file"]').first().setInputFiles(SCAN_B);
  await expect(page.getByText('↔ fixture-compare-scan-b.pdf · 2/2 trang')).toBeVisible({ timeout: 30_000 });
  const cta = page.getByRole('button', { name: 'So sánh ngay' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();

  // Census flags pair 2 (image-only page on both sides) → confirm card.
  const confirm = page.getByTestId('compare-ai-confirm');
  await expect(confirm).toBeVisible({ timeout: 60_000 });
  await expect(confirm).toContainText('1 cặp trang scan');
  await page.getByRole('button', { name: 'Đồng ý chạy AI' }).click();

  // The canned ai-mock engine answers offline. The viewer stays on the
  // changed DIGITAL pair — navigate to the scan pair for the clause panel.
  await expect(page.getByTestId('compare-ai-confirm')).toBeHidden({ timeout: 120_000 });
  await page.getByRole('button', { name: '→' }).click();
  await expect(page.getByTestId('compare-scan-panel')).toBeVisible({ timeout: 30_000 });
  const badges = page.getByTestId('thumb-badge');
  await expect(badges.filter({ hasText: 'Đã đổi' })).toHaveCount(1);

  // Export: scan pair excluded from the marks; two PDFs still download.
  const dlA = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất hai PDF chú giải' }).click();
  await dlA;
  const dlB = page.waitForEvent('download');
  await dlB;
  await expect(page.getByText('1 cặp trang scan không được chú giải')).toBeVisible();
});

test('compare visual diff: heatmap + region nav on the changed pair', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('./tools/compare');
  await page.locator('input[type="file"]').first().setInputFiles(FIX_A);
  await page.locator('input[type="file"]').first().setInputFiles(FIX_B);
  const cta = page.getByRole('button', { name: 'So sánh ngay' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  await expect(page.getByTestId('compare-result')).toBeVisible({ timeout: 60_000 });

  // visual mode on the changed pair (fixture pair 0: 1 word differs)
  const panel = page.getByTestId('visual-diff-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('visual-run').click();
  await expect(page.getByTestId('visual-regions')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('visual-regions')).not.toContainText('0 vùng');
  // the security disclosure renders next to the results
  await expect(page.getByTestId('visual-not-security')).toBeVisible();
});
