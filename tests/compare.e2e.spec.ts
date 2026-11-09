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
});
