import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/*
 * Android share-target POST → suggestion sheet (plan v0.3.0 phase 6b).
 *
 * The POST must be a REAL top-level navigation, not a fetch(): fetch is a
 * subresource — request.mode !== 'navigate' and the SW handler ignores it by
 * design (red-team F23: testing any other path would exercise a dead branch).
 *
 * The app's CSP says `form-action 'none'`, which (correctly) blocks a form
 * submitted from the app document. The production share-sheet POST has no
 * initiating document at all, so the test drives the navigation from an
 * about:blank page in the same browser context — no CSP applies there, and
 * the SW still intercepts because the TARGET url is inside its scope.
 *
 * The SW-controlled wait is mandatory: an uncontrolled preview server 404s
 * the POST before the SW ever sees it.
 */

async function waitForSwControlled(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  await page.waitForFunction(
    async () => {
      if (!navigator.serviceWorker) return false;
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
}

/** Submit a multipart POST from a CSP-free page; returns the landing tab. */
async function submitShareForm(
  context: BrowserContext,
  action: string,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const landing = await context.newPage();
  await landing.goto('about:blank');
  await landing.evaluate((actionUrl) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.enctype = 'multipart/form-data';
    form.action = actionUrl;
    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'files';
    form.appendChild(input);
    document.body.appendChild(form);
  }, action);
  await landing.setInputFiles('input[name="files"]', file);
  await landing.evaluate(() => (document.querySelector('form') as HTMLFormElement).submit());
  return landing;
}

test('share-target POST navigation delivers a valid PDF to the suggestion sheet', async ({
  page,
}) => {
  await waitForSwControlled(page);
  const landing = await submitShareForm(
    page.context(),
    'http://localhost:4173/pdftoolkit/share-target',
    {
      name: 'shared.pdf',
      mimeType: 'application/pdf',
      buffer: readFileSync('tests/fixtures/fixture-1mb.pdf'),
    },
  );
  // 303 lands on home (?share-target=1), the handshake hands the file over
  // and the sheet opens. Do NOT waitForURL on the param — cleanShareParam
  // strips it right after mount and races the waiter.
  const sheet = landing.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByText('Gợi ý cho 1 file')).toBeVisible();
  // Single valid PDF ranks compress and unlocks the all-tools grid (both
  // surfaces show the tool name — hence .first()).
  await expect(sheet.getByText('Nén PDF').first()).toBeVisible();
  // The landing param is consumed, so a reload cannot replay the handshake.
  expect(new URL(landing.url()).searchParams.has('share-target')).toBe(false);
  await landing.close();
});

test('share-target POST with a garbage file lands in the sheet rejected list', async ({ page }) => {
  await waitForSwControlled(page);
  const landing = await submitShareForm(
    page.context(),
    'http://localhost:4173/pdftoolkit/share-target',
    {
      name: 'fake.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('definitely not a pdf'),
    },
  );
  const sheet = landing.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  // Same intake gate as drag-drop: magic-byte sniff rejects the renamed file.
  await expect(sheet.getByText('fake.pdf — không phải PDF', { exact: false })).toBeVisible();
  await landing.close();
});
