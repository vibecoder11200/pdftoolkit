import { expect, test } from '@playwright/test';

/*
 * v0.13.0 phase 3 (web e2e): build a watermark→compress chain in the
 * builder, save, see the custom card on the strip, start it and land on
 * watermark with the PREFILLED stamp text (mount prefill through the
 * reworked session). Chain continues via the banner like a builtin.
 */

test('builder: create watermark→compress chain, run it, prefill lands', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByTestId('preset-create').click();
  const builder = page.getByTestId('preset-builder');
  await expect(builder).toBeVisible();

  // Name the chain.
  await builder.getByPlaceholder('Ví dụ: Đóng dấu rồi nén').fill('E2E chuỗi thử');
  // Step 1: watermark with a custom stamp text.
  await builder.getByTestId('builder-add-select').selectOption('watermark');
  await builder.locator('[data-testid="builder-step"] input').fill('E2E-STAMP');
  // Step 2: compress (mode defaults to vector).
  await builder.getByTestId('builder-add-select').selectOption('compress');
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('preset-builder')).toHaveCount(0);

  // The custom card shows on the strip (after the builtins).
  const card = page.locator('[data-testid="preset-card"][data-preset^="custom:"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('E2E chuỗi thử');

  // Start the chain → intake dropzone → park a file → navigate to watermark.
  await card.click();
  const intake = page.getByTestId('preset-intake');
  await expect(intake).toBeVisible();
  await intake.locator('input[type="file"]').setInputFiles('tests/fixtures/fixture-small.pdf');
  await page.waitForURL(/\/tools\/watermark/);
  // Prefill: the stamp textarea carries the authored default.
  const stamp = page.getByPlaceholder('BẢN MẪU');
  await expect(stamp).toHaveValue('E2E-STAMP', { timeout: 30_000 });
  // Session banner shows the custom chain name.
  await expect(page.getByTestId('preset-banner')).toContainText('E2E chuỗi thử');
});

test('builder: v1 guards — 2-step minimum, no repeated slug', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('preset-create').click();
  const builder = page.getByTestId('preset-builder');
  await expect(builder).toBeVisible();
  await builder.getByTestId('builder-add-select').selectOption('merge');
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('builder-error')).toContainText('ít nhất 2 bước');
  // Used slugs disappear from the add-select (no-repeat rule in the UI).
  const remaining = await builder
    .getByTestId('builder-add-select')
    .locator('option')
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(remaining).not.toContain('merge');
  await page.keyboard.press('Escape');
});
