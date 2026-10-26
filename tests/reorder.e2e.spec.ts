import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/*
 * Reorder e2e (v0.9.0 phase 8) — the FIRST reorder coverage in the repo.
 * Three legs: desktop pointer drag on the grip handle, the explicit
 * move-button fallback, and a phone viewport driven with REAL touch events
 * (CDP touch → synthesized pointer events, pointerType touch) — HTML5 DnD
 * never fires on touch, the pointer handle is the mechanic.
 */

const FIX_OUT = 'test-results/reorder-e2e-fixture.pdf';

async function buildReorderFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['ONE', 'TWO', 'THREE']) {
    const page = doc.addPage([400, 300]);
    page.drawText(label, { x: 40, y: 150, size: 40, font });
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
}

/** The ORIGINAL page numbers in display order (the strip's pageNumber is
 * the display position and always renumbers; the order list below the
 * strip shows the source page per position — the real oracle). */
async function pageOrder(page: Page): Promise<number[]> {
  const rows = page.locator('ol[aria-label] > li');
  const count = await rows.count();
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const text = await rows.nth(i).locator('span').nth(1).textContent();
    out.push(Number(text!.match(/\d+/)![0]));
  }
  return out;
}

async function arrange(page: Page): Promise<void> {
  await buildReorderFixture(FIX_OUT);
  await page.goto('./tools/reorder');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-page-cell]').length >= 3,
    undefined,
    { timeout: 30_000 },
  );
  // Thumbnails render lazily — give the images a beat.
  await page.waitForTimeout(400);
}

test('reorder (desktop): drag handle reorders pages', async ({ page }) => {
  test.setTimeout(120_000);
  await arrange(page);
  expect(await pageOrder(page)).toEqual([1, 2, 3]);

  const handle = page.locator('[data-page-cell="1"] [aria-label^="Kéo để đổi thứ tự trang 1"]');
  const target = page.locator('[data-page-cell="3"]');
  const h = (await handle.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await pageOrder(page)).toEqual([2, 3, 1]);
});

test('reorder (desktop): the explicit move buttons reorder without dragging', async ({ page }) => {
  test.setTimeout(120_000);
  await arrange(page);
  await page.locator('[data-page-cell="3"] [aria-label^="Chuyển trang 3 sang trái"]').click();
  expect(await pageOrder(page)).toEqual([1, 3, 2]);
});

test.describe('reorder (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('touch-drag on the handle reorders pages', async ({ page }) => {
  test.setTimeout(120_000);
  await arrange(page);
  expect(await pageOrder(page)).toEqual([1, 2, 3]);

  // Real touch: CDP touch events synthesize pointer events with
  // pointerType 'touch' — the code path a phone actually runs.
  const cdp = await page.context().newCDPSession(page);
  const handle = page.locator('[data-page-cell="1"] [aria-label^="Kéo để đổi thứ tự trang 1"]');
  const target = page.locator('[data-page-cell="2"]');
  // Thumbnails stack ~400px tall on phone: scroll cell 2 into view, then
  // nudge so the cell-1 handle is on-screen too, and measure AFTER.
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  let h = (await handle.boundingBox())!;
  if (h.y < 20) {
    await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(60 - h.y));
    await page.waitForTimeout(150);
    h = (await handle.boundingBox())!;
  }
  const t = (await target.boundingBox())!;
  const sx = h.x + h.width / 2;
  const sy = h.y + h.height / 2;
  const ex = t.x + t.width / 2;
  const ey = t.y + t.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: sx, y: sy, id: 1 }],
  });
  for (let i = 1; i <= 8; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: sx + ((ex - sx) * i) / 8, y: sy + ((ey - sy) * i) / 8, id: 1 }],
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await pageOrder(page)).toEqual([2, 1, 3]);
  });
});
