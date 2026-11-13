import { expect, test } from '@playwright/test';

// The capture guard owns browser navigation prevention only; editor intake
// and pointer-based mark drawing must still behave normally.
test('off-target Files drop preserves editor source, URL and marks', async ({ page }) => {
  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/fixture-small.pdf');
  const overlay = page.getByTestId('editor-overlay');
  await expect(overlay).toBeVisible();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    return !!canvas && canvas.width > 100;
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.08);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.13, { steps: 6 });
  await page.mouse.up();
  const marks = page.locator('[aria-label^="mark-"]');
  await expect(marks).toHaveCount(1);
  const url = page.url();
  const ids = await marks.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  const cancelled = await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['not a replacement'], 'off-target.pdf', { type: 'application/pdf' }));
    const target = document.querySelector('header')!;
    target.addEventListener('drop', event => event.stopPropagation(), { once: true });
    return !target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  expect(cancelled).toBe(true);
  expect(page.url()).toBe(url);
  await expect(page.getByText('fixture-small.pdf', { exact: false }).first()).toBeVisible();
  expect(await marks.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(ids);

  // Hold the real engine's outgoing calls at a safe test boundary so the
  // editor stays busy while the same off-target drop is exercised.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    const held: (() => void)[] = [];
    Worker.prototype.postMessage = function (this: Worker, message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const worker = this;
      held.push(() => Reflect.apply(original, worker, [message, options]));
    };
    (window as unknown as { releaseEngine: () => void }).releaseEngine = () => {
      Worker.prototype.postMessage = original;
      held.forEach(send => send());
    };
  });
  await page.locator('textarea').fill('PDFTOOLKIT FIXTURE');
  const apply = page.getByRole('button', { name: 'Xác nhận che đi', exact: true });
  await apply.click();
  await expect(apply).toBeDisabled();
  const busyCancelled = await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['ignored'], 'busy-drop.pdf', { type: 'application/pdf' }));
    return !document.querySelector('header')!.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer,
    }));
  });
  expect(busyCancelled).toBe(true);
  expect(page.url()).toBe(url);
  expect(await marks.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(ids);
  await page.evaluate(() => (window as unknown as { releaseEngine: () => void }).releaseEngine());
});
