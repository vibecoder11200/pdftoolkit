import { expect, test } from '@playwright/test';

/*
 * Scan-cleanup e2e (web, phase 6): dirty-scan fixture -> preview renders
 * -> deskew + threshold applied -> cleaned PDF export (delivery contract).
 */

test('scan-cleanup: preview, deskew+threshold, export', async ({ page }) => {
  await page.goto('./tools/scan-cleanup');
  await page.setInputFiles('input[type="file"]', ['tests/fixtures/fixture-scan-dirty.pdf']);

  // before/after preview renders (canvas populated)
  await expect(page.getByTestId('cleanup-before-canvas')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('[data-testid="cleanup-before-canvas"]') as HTMLCanvasElement | null;
      return !!c && c.width > 100;
    },
    { timeout: 30_000 },
  );

  // enable deskew + threshold mode (settings drive the preview)
  await page.getByTestId('cleanup-deskew').check();
  await page.getByTestId('cleanup-mode').selectOption('threshold');

  // export -> single PDF download rides the delivery contract
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 90_000 }),
    page.getByTestId('cleanup-export').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-da-ve-sinh\.pdf$/);
});

test('scan-cleanup: orientation suggestion confirms, never auto-applies', async ({ page }) => {
  await page.goto('./tools/scan-cleanup?osd-mock=1');
  await page.setInputFiles('input[type="file"]', ['tests/fixtures/fixture-scan-dirty.pdf']);
  await expect(page.getByTestId('cleanup-before-canvas')).toBeVisible({ timeout: 30_000 });

  // ask -> suggestion shows (osd-mock: 180deg + 42%) but rotation stays 0
  await page.getByTestId('cleanup-orient-ask').click();
  await expect(page.getByTestId('cleanup-orient-verdict')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('cleanup-orient-verdict')).toContainText('180°');
  // nothing applied until the explicit apply button
  await expect(page.getByTestId('cleanup-rot-0')).toHaveClass(/border-accent/);
  // explicit apply -> manual rotation flips to the suggestion
  await page.getByTestId('cleanup-orient-apply').click();
  await expect(page.getByTestId('cleanup-rot-180')).toHaveClass(/border-accent/);
});
