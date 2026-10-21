import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/*
 * Watermark tool e2e (v0.8.0 phase 5). The downloaded bytes are parsed with
 * the pdfjs-dist legacy build right here in the Playwright node context —
 * the strongest available oracle for "stamped text is extractable on the
 * target pages only" (VN diacritics byte-correct through the subset Roboto).
 */

const FIX = 'tests/fixtures';

async function pdfjsLegacy() {
  const require = createRequire(import.meta.url);
  return require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
}

async function stampItemsOf(pdfPath: string, pageNumbers: number[]): Promise<string[][]> {
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: new Uint8Array(readFileSync(pdfPath)) });
  const doc = await task.promise;
  try {
    const out: string[][] = [];
    for (const n of pageNumbers) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      out.push(tc.items.map((i) => ('str' in i ? String(i.str) : '')));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

async function waitForThumbs(page: Page, count: number) {
  await expect(page.locator('[role="checkbox"]')).toHaveCount(count, { timeout: 30_000 });
}

test('T1: text stamp on every page — VN diacritics extract byte-exact, all pages', async ({
  page,
}) => {
  await page.goto('./tools/watermark');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-geom.pdf`);
  await waitForThumbs(page, 8);
  // Default stamp text is "BẢN MẪU" — exactly the acceptance string.
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Đóng dấu và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fixture-geom-watermarked.pdf');
  const path = await download.path();
  for (const p of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const items = (await stampItemsOf(path!, [p]))[0];
    expect(items.join(' '), `page ${p}`).toContain('BẢN MẪU');
  }
});

test('T2: page scope — marker on the kept pages only', async ({ page }) => {
  await page.goto('./tools/watermark');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-geom.pdf`);
  await waitForThumbs(page, 8);
  // Default = all selected; deselect everything except pages 2 and 4.
  const thumbs = page.locator('[role="checkbox"]');
  for (const p of [1, 3, 5, 6, 7, 8]) {
    await thumbs.nth(p - 1).click();
    await expect(thumbs.nth(p - 1)).toHaveAttribute('aria-checked', 'false');
  }
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Đóng dấu và tải xuống' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  for (const p of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const items = (await stampItemsOf(path!, [p]))[0];
    const has = items.some((s) => s.includes('BẢN MẪU'));
    if (p === 2 || p === 4) expect(has, `page ${p} stamped`).toBe(true);
    else expect(has, `page ${p} clean`).toBe(false);
  }
});

test('T3: rotated placement — stamp lands top-right on a /Rotate 90 page', async ({
  page,
}) => {
  await page.goto('./tools/watermark');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-rotated.pdf`);
  await waitForThumbs(page, 4);
  await page.getByRole('textbox').first().fill('WMORACLE');
  // 9-grid: first row, third button = top-right.
  const grid = page.getByRole('radiogroup', { name: 'Vị trí' });
  await grid.getByRole('radio').nth(2).click();
  await expect(grid.getByRole('radio').nth(2)).toHaveAttribute('aria-checked', 'true');
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Đóng dấu và tải xuống' }).click();
  const download = await downloadPromise;
  const path = await download.path();

  // Same math as the phase-1 property matrix, now against the real UI run.
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: new Uint8Array(readFileSync(path!)) });
  const doc = await task.promise;
  try {
    for (const n of [1, 2, 3, 4]) {
      const p = await doc.getPage(n);
      const viewport = p.getViewport({ scale: 1 });
      const W = viewport.width;
      const H = viewport.height;
      const tc = await p.getTextContent();
      const hit = tc.items.find((i) => 'str' in i && String(i.str).includes('WMORACLE'));
      expect(hit, `page ${n} carries the stamp`).toBeTruthy();
      const t = (hit as { transform: number[] }).transform;
      const [dx, dy] = viewport.convertToViewportPoint(t[4], t[5]);
      // Top-right ninth of the DISPLAYED page (device y grows downward), with
      // a small slack for the ascent/width approximations.
      const slack = 12;
      expect(
        dx,
        `page ${n} stamp x (${dx.toFixed(0)}) in right third of ${W.toFixed(0)}`,
      ).toBeGreaterThan((2 * W) / 3 - 70);
      expect(dy, `page ${n} stamp y (${dy.toFixed(0)}) in top third of ${H.toFixed(0)}`).toBeLessThan(
        H / 3 + 70 + slack,
      );
    }
  } finally {
    await task.destroy();
  }
});

test('T4: image watermark — output parses and grows', async ({ page }) => {
  await page.goto('./tools/watermark');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  await waitForThumbs(page, 2);
  await page.getByRole('tab', { name: 'Ảnh' }).click();
  await page.setInputFiles('input[accept^="image"]', `${FIX}/fixture-photo.png`);
  await expect(page.getByText('fixture-photo.png')).toBeVisible();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Đóng dấu và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fixture-small-watermarked.pdf');
  const path = await download.path();
  const out = readFileSync(path!);
  expect(out.byteLength).toBeGreaterThan(readFileSync(`${FIX}/fixture-small.pdf`).byteLength);
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: new Uint8Array(out) });
  const doc = await task.promise;
  const p = await doc.getPage(1);
  const tc = await p.getTextContent();
  expect(tc.items.map((i) => ('str' in i ? String(i.str) : '')).join(' ')).toContain(
    'PDFTOOLKIT FIXTURE small',
  );
  await task.destroy();
});

test('T5: folder batch — 2 per-file downloads + named failure for the locked file', async ({
  page,
}) => {
  // First-of-kind webkitdirectory interaction: the chooser takes a DIRECTORY
  // path (validated against the dev server in phase-2 step 7).
  const dir = join('test-results', 'watermark-batch');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(`${FIX}/fixture-small.pdf`, join(dir, 'a-small.pdf'));
  copyFileSync(`${FIX}/fixture-pagenums.pdf`, join(dir, 'b-pagenums.pdf'));
  copyFileSync(`${FIX}/fixture-locked.pdf`, join(dir, 'c-locked.pdf'));

  await page.goto('./tools/watermark');
  // The batch button gates on a loaded file (selection non-empty).
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  await waitForThumbs(page, 2);

  const downloads: string[] = [];
  page.on('download', (d) => void downloads.push(d.suggestedFilename()));
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.getByRole('button', { name: 'Đóng dấu cả thư mục' }).click(),
  ]);
  await chooser.setFiles(dir);
  await expect(page.getByText(/2\/3 thành công/)).toBeVisible({ timeout: 60_000 });
  expect(downloads.sort()).toEqual(['a-small-watermarked.pdf', 'b-pagenums-watermarked.pdf']);
  const note = await page.getByText(/2\/3 thành công/).textContent();
  expect(note).toContain('c-locked.pdf');
  rmSync(dir, { recursive: true, force: true });
});
