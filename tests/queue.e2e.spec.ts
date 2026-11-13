import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase-7 batch queue e2e (web): merge through the REAL engine via the
 * queue panel — enqueue two PDFs, ONE download through the phase-3 web
 * dispatch, item state lands succeeded, ledger keeps exactly one entry.
 */

const FIX_A = join("tests/fixtures/fixture-compare-a.pdf");
const FIX_B = join("tests/fixtures/fixture-compare-b.pdf");

test("queue: two-file merge runs and delivers once", async ({ page }) => {
  test.setTimeout(180_000);
  if (readFileSync(FIX_A).length === 0 || readFileSync(FIX_B).length === 0) {
    throw new Error("queue fixtures missing - run node tests/fixtures/gen.mjs first");
  }

  await page.goto("./tools/merge");
  const dlPromise = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByTestId("queue-toggle").click();
  await page.getByTestId("queue-input").setInputFiles([FIX_A, FIX_B]);
  await page.getByTestId("queue-add").click();
  const download = await dlPromise;
  expect(download.suggestedFilename()).toBe("gop-tai-lieu.pdf");
  await expect(page.getByTestId("queue-item-state")).toContainText("Hoàn tất", { timeout: 60_000 });
  await expect(page.getByTestId("queue-item")).toHaveCount(1);
  await expect(page.getByTestId("queue-item-state")).not.toContainText("Thất bại");
});
