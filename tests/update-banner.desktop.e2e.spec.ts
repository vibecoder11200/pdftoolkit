import { expect, test, type Page } from '@playwright/test';

/*
 * DESKTOP update banner e2e (v0.5.0 phase 6 — red-team F7). The real plugin
 * guest code runs against a scripted __TAURI_INTERNALS__: check returns an
 * update resource; download_and_install streams progress events through the
 * Channel callback (the same transformCallback + "__CHANNEL__:<id>" wire
 * format the Tauri host uses). Regression: the old banner unmounted the
 * moment the phase left 'available', so the download % and errors were dead
 * code — these tests require the banner to live through downloading,
 * installing and error.
 */


const UPDATE_RESOURCE = {
  rid: 7,
  currentVersion: '0.0.0',
  version: '9.9.9',
  date: null,
  body: null,
  rawJson: '{}',
};

interface InstallScript {
  /** progress: stream Started/75%/Finished; error: reject with `message`. */
  mode: 'progress' | 'error';
  holdMs?: number;
  message?: string;
}

async function setupUpdater(
  page: Page,
  install: InstallScript,
  checkResponse: unknown = null,
): Promise<void> {
  await page.addInitScript(({ script, check }) => {
    const calls: { cmd: string; payload?: unknown }[] = [];
    const callbacks = new Map<number, (raw: unknown) => void>();
    let nextId = 1;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, payload?: Record<string, unknown>) => {
        calls.push({ cmd, payload });
        if (cmd === 'initial_open_files') return [];
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'plugin:updater|check') return check;
        if (cmd === 'plugin:updater|download_and_install') {
          if (script.mode === 'error') throw new Error(script.message ?? 'install failed');
          // The guest passes the Channel INSTANCE across this mocked boundary
          // (no IPC serialization → toJSON never runs), so read `.id` — the
          // "__CHANNEL__:<id>" string only exists on the real wire. A
          // String() coercion here yields "[object Object]" → NaN → every
          // deliver() is a no-op and the flow skips straight to restarting.
          const raw = payload?.onEvent as { id?: number } | string | undefined;
          const chanId =
            typeof raw === 'string' ? Number(raw.split(':')[1]) : Number(raw?.id);
          let index = 0;
          const deliver = (message: unknown) =>
            callbacks.get(chanId)?.({ index: index++, message });
          deliver({ event: 'Started', data: { contentLength: 200 } });
          deliver({ event: 'Progress', data: { chunkLength: 150 } }); // 75%
          if ((script.holdMs ?? 0) > 0) {
            await new Promise((r) => setTimeout(r, script.holdMs));
          }
          deliver({ event: 'Progress', data: { chunkLength: 50 } });
          deliver({ event: 'Finished' });
          // Resolve `installing` honestly: a real installer spends seconds
          // between "download finished" and "app relaunch", and resolving
          // the invoke in the same tick as Finished lets React batch
          // installing+restarting into one paint — the phase would be
          // unobservable. 1s keeps the window far clear of the assert poll.
          await new Promise((r) => setTimeout(r, 1000));
          return null;
        }
        if (cmd === 'plugin:process|relaunch') return null;
        return null;
      },
      transformCallback: (cb: (raw: unknown) => void) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
    };
    (window as unknown as Record<string, unknown>).__desktopCalls = calls;
  }, { script: install, check: checkResponse });
}

test('banner lives through available → downloading → installing → restarting (F7 regression)', async ({
  page,
}) => {
  await setupUpdater(page, { mode: 'progress', holdMs: 1500 }, UPDATE_RESOURCE);
  await page.goto('./tools/merge'); // deep link: the banner shows above any route
  // available
  await expect(page.getByText('Đã có phiên bản mới của ứng dụng.')).toBeVisible();
  await page.getByTestId('update-reload').click();
  // downloading: the banner must STAY (old code unmounted here — dead progress)
  await expect(page.getByText(/Đang tải bản cập nhật/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/75%/)).toBeVisible();
  expect(await page.getByTestId('update-reload').count()).toBe(0); // no double-click
  // installing (Finished event) then restarting (flow resolves)
  await expect(page.getByText('Đang cài đặt bản cập nhật…')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Đã tải xong — ứng dụng sẽ tự khởi động lại…')).toBeVisible({
    timeout: 10_000,
  });
});

test('error phase surfaces the failure message with a Retry button', async ({ page }) => {
  await setupUpdater(page, { mode: 'error', message: 'endpoint down (mock)' }, UPDATE_RESOURCE);
  await page.goto('/');
  await page.getByTestId('update-reload').click();
  await expect(page.getByText(/Cập nhật thất bại: endpoint down/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId('update-retry')).toBeVisible();
});

test('no update published → banner never appears', async ({ page }) => {
  await setupUpdater(page, { mode: 'progress' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  await page.waitForTimeout(300);
  await expect(page.getByText('Đã có phiên bản mới của ứng dụng.')).toHaveCount(0);
});

test('settings updates card: manual check, no update → up-to-date copy, banner never appears', async ({
  page,
}) => {
  await setupUpdater(page, { mode: 'progress' }); // check() → null
  await page.goto('./settings');
  const card = page.getByTestId('updates-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  // The mount auto-check already resolved to "up to date"; the manual check
  // re-runs it on demand — the whole point of the card.
  await page.getByTestId('updates-check').click();
  await expect(page.getByTestId('updates-status')).toContainText('bản mới nhất', {
    timeout: 10_000,
  });
  await expect(card.getByTestId('updates-check')).toBeEnabled();
  await expect(page.getByText('Đã có phiên bản mới của ứng dụng.')).toHaveCount(0);
});

test('settings updates card: update found → remote version on the card, install runs from there', async ({
  page,
}) => {
  await setupUpdater(page, { mode: 'progress', holdMs: 1200 }, UPDATE_RESOURCE);
  await page.goto('./settings');
  const card = page.getByTestId('updates-card');
  // The mount auto-check surfaces the banner AND the card state together.
  await expect(page.getByText('Đã có phiên bản mới của ứng dụng.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(card).toContainText('9.9.9');
  // Install from the CARD — both surfaces mirror the shared store: the card
  // status line AND the banner (which owns the progress UI).
  await card.getByTestId('updates-install').click();
  await expect(page.getByTestId('update-banner')).toContainText('Đang tải bản cập nhật… 75%', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('updates-status')).toContainText('75%');
});
