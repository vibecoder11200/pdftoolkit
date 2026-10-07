import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

/*
 * AcroForm fill tool e2e (phase 6b): every field type end-to-end, the
 * flatten confirm flow, R15 signed-PDF warnings, and the XFA refusal.
 * Runs against the built dist (playwright webServer) with fixtures from
 * tests/fixtures/gen.mjs — `node tests/fixtures/gen.mjs` must have produced
 * form-vn-full.pdf / form-vn-signed.pdf / form-xfa.pdf first (gitignored).
 */

const readFixture = (name: string) => `tests/fixtures/${name}`;

test.beforeEach(async ({ page }) => {
  await page.goto('./tools/fill-form');
});

async function loadForm(page: Page, fixture: string) {
  await page.setInputFiles('input[type="file"]', readFixture(fixture));
  await expect(page.getByTestId('fields-title')).toBeVisible({ timeout: 30_000 });
}

test('fills every field type and downloads the filled PDF', async ({ page }) => {
  await loadForm(page, 'form-vn-full.pdf');
  await expect(page.getByTestId('fields-title')).toHaveText('8 trường biểu mẫu');

  // Text single-line + multiline + AUTO multiline.
  await page.getByLabel('Họ và tên').fill('Nguyễn Văn Ánh');
  await page.getByLabel('Địa chỉ').fill('48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng');
  await page.getByLabel('Ghi chú').fill('Ghi chú có dấu: Đà Lạt.');
  // Readonly field shows its value, disabled.
  await expect(page.getByText('FT-2026-VN')).toBeVisible();
  // Checkbox.
  await page.getByRole('checkbox', { name: 'Đồng ý điều khoản' }).check();
  // Radio group (2 options → inline radios).
  await page.getByRole('radio', { name: 'nu' }).check();
  // Radio group with 5 options → dropdown-style select (>4 rule).
  await page.getByLabel('Khu vực').selectOption('mn');
  // Dropdown.
  await page.getByLabel('Nghề nghiệp').selectOption('Kỹ sư');

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Tải PDF đã điền' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('form-vn-full-filled.pdf');

  // axe: no serious/critical violations on the loaded, filled form panel.
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, bad.map((v) => v.id).join(', ')).toEqual([]);
});

test('flatten requires the irreversible confirm and bakes the fields away', async ({ page }) => {
  await loadForm(page, 'form-vn-full.pdf');
  await page.getByLabel('Họ và tên').fill('Trần Văn Bình');
  await page.getByTestId('flatten-toggle').check();

  // The CTA now routes through the confirm dialog instead of downloading.
  await page.getByRole('button', { name: 'Tải PDF đã điền' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('không thể hoàn tác')).toBeVisible();

  await dialog.getByRole('button', { name: 'Ép phẳng và tải xuống' }).click();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('form-vn-full-filled.pdf');

  // Structural proof: the download has zero form fields left (all baked).
  const bytes = new Uint8Array(readFileSync(await download.path()));
  const doc = await PDFDocument.load(bytes);
  expect(doc.getForm().getFields()).toHaveLength(0);
});

test('signed PDF warns before fill and HARD-warns before flatten (R15)', async ({ page }) => {
  await loadForm(page, 'form-vn-signed.pdf');
  // Soft pre-fill warning…
  await expect(page.getByTestId('signed-warning')).toBeVisible();
  await expect(page.getByTestId('signed-warning')).toContainText('File đã có chữ ký số');
  // …and the HARD warning inside the flatten confirm.
  await page.getByTestId('flatten-toggle').check();
  await page.getByRole('button', { name: 'Tải PDF đã điền' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('flatten-signed-warning')).toBeVisible();
  await expect(dialog.getByTestId('flatten-signed-warning')).toContainText(
    'vô hiệu hoá chữ ký số hiện có',
  );
  // Cancel keeps the form interactive — no bake without explicit consent.
  await dialog.getByRole('button', { name: 'Giữ form tương tác' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('flatten-toggle')).toBeChecked();
});

test('XFA form refuses with the dedicated copy and a disabled CTA', async ({ page }) => {
  await page.setInputFiles('input[type="file"]', readFixture('form-xfa.pdf'));
  await expect(page.getByText('Form XFA chưa được hỗ trợ')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Tải PDF đã điền' })).toBeDisabled();
});

test('encrypted form unlocks in place and the fields become fillable', async ({ page }) => {
  await page.setInputFiles('input[type="file"]', readFixture('form-vn-locked.pdf'));
  await expect(page.getByText('File đang khóa mật khẩu.')).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder('Nhập mật khẩu của file').fill('pdftoolkit');
  await page.getByRole('button', { name: 'Giải mã và điền form' }).click();
  await expect(page.getByTestId('fields-title')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fields-title')).toHaveText('8 trường biểu mẫu');
  await page.getByLabel('Họ và tên').fill('Phạm Thị Vui');
});
