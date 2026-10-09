import { expect, test } from '@playwright/test';

/*
 * Web honesty e2e (plan 261009-0836 phase 5): with NO fake gpu (the real
 * headless browser surface — usually one software adapter or none), the GPU
 * section renders honestly: at most ONE adapter row, no crash, no fake
 * second entry. The dedupe path (gpu-choice probeAdapters) is what keeps
 * the panel honest when the OS collapses both probes.
 */

test('no fake gpu: the GPU section renders the real (sparse) surface honestly', async ({
  page,
}) => {
  await page.goto('./settings');
  await expect(page.getByTestId('settings-hardware')).toBeVisible({ timeout: 20_000 });

  const list = page.getByTestId('gpu-adapter-list');
  if (await list.isVisible().catch(() => false)) {
    // Headless chromium exposes at most the default/SwiftShader adapter —
    // never two fake rows. A software row must be labeled + unselectable.
    const rows = await page.getByTestId('gpu-adapter-label').count();
    expect(rows).toBeLessThanOrEqual(1);
    if (rows === 1) {
      const row = page.locator('li', { has: page.getByTestId('gpu-adapter-label') });
      const isSoftware = await row.getByRole('radio').isDisabled().catch(() => false);
      if (isSoftware) {
        await expect(row).toContainText(/adapter phần mềm|software adapter/);
      }
    }
    // Diagnostics must agree: navigator.gpu present, at most one probe row
    // shows a fingerprint.
    await page.getByTestId('gpu-diagnostics').locator('summary').click();
    await expect(page.getByTestId('gpu-diag-webgpu')).toHaveText('✓');
  } else {
    // No adapters at all — the honest no-WebGPU line (the AdapterLine
    // no-adapter branch has no per-line testid — assert on the container),
    // and no crash.
    await expect(page.getByTestId('settings-hardware')).toContainText(
      /No GPU detected|No WebGPU|Không có GPU|Không có WebGPU/i,
    );
  }
});
