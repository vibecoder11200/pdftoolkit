import { expect, test, type Page } from '@playwright/test';
import { stubTauri, readCalls } from './helpers/tauri-mock';

/*
 * Settings native-engine card e2e (v0.6.0 phase 6, R6.3): status renders
 * from the mocked native_engine_status; the CUDA row is ALWAYS visible
 * (validation V2) but its install button ENABLES only on an NVIDIA hit —
 * both fixtures in one spec; the storage row shows the mocked bytes and
 * its delete flows through native_engine_delete.
 */

type Fixture = { engine: boolean; model: boolean; cuda: boolean; nvidia: boolean };

async function arrange(page: Page, f: Fixture) {
  await stubTauri(page);
  await page.addInitScript((fixture) => {
    const w = window as unknown as {
      __tauriSetHandler: (c: string, fn: (p?: unknown) => unknown) => void;
    };
    const full = {
      phase: 'stopped',
      backend: 'vulkan',
      cpuFallback: false,
      devices: fixture.engine && fixture.nvidia ? ['Vulkan1: NVIDIA RTX 3050'] : null,
      enginePresent: fixture.engine,
      modelPresent: fixture.model,
      cudaPresent: fixture.cuda,
      sizes: {
        engine: fixture.engine ? 33_500_000 : 0,
        cuda: fixture.cuda ? 600_000_000 : 0,
        model: fixture.model ? 1_400_000_000 : 0,
      },
      lastError: null,
    };
    w.__tauriSetHandler('native_engine_status', () => full);
    w.__tauriSetHandler('native_engine_probe', () =>
      fixture.engine && fixture.nvidia ? ['Vulkan1: NVIDIA RTX 3050'] : [],
    );
    w.__tauriSetHandler('native_engine_delete', () => 1_000);
    w.__tauriSetHandler('native_cancel', () => undefined);
  }, f);
}

test('installed machine: status, sizes, CUDA enabled on NVIDIA probe', async ({ page }) => {
  await arrange(page, { engine: true, model: true, cuda: false, nvidia: true });
  await page.goto('./settings');
  const card = page.getByTestId('native-engine-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('native-status')).toContainText('Đã dừng');
  // CUDA row ALWAYS visible — enabled because the probe reports NVIDIA.
  await expect(page.getByTestId('native-cuda-row')).toBeVisible();
  await expect(page.getByTestId('native-cuda-download')).toBeEnabled();
  // Storage row shows the mocked bytes (engine + model + cuda = 0 here).
  await expect(page.getByTestId('size-native-engine')).toContainText(/GB|MB/);
});

test('no NVIDIA anywhere: CUDA row visible but install disabled with the reason', async ({
  page,
}) => {
  await arrange(page, { engine: true, model: false, cuda: false, nvidia: false });
  await page.goto('./settings');
  await expect(page.getByTestId('native-cuda-row')).toBeVisible();
  await expect(page.getByTestId('native-cuda-download')).toBeDisabled();
  await expect(page.getByText('Cần card NVIDIA để dùng backend này')).toBeVisible();
});

test('storage row delete flows through native_engine_delete (all three kinds)', async ({
  page,
}) => {
  await arrange(page, { engine: true, model: true, cuda: false, nvidia: false });
  await page.goto('./settings');
  await expect(page.getByTestId('row-native-engine')).toBeVisible();
  await page.getByTestId('delete-native-engine').click();
  // The delete awaits the dynamic core import before invoking — poll.
  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'native_engine_delete').length;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);
  const kinds = (await readCalls(page))
    .filter((c) => c.cmd === 'native_engine_delete')
    .map((c) => (c.payload as { kind: string }).kind);
  expect(kinds).toEqual(expect.arrayContaining(['model', 'engine', 'cuda']));
});
