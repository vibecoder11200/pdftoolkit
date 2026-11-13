import { expect, test } from "@playwright/test";
import { readCalls, stubTauri } from "./helpers/tauri-mock";

/*
 * Phase-7 batch queue e2e (desktop): merge via the queue panel delivers
 * through the phase-3 desktop contract - ONE native directory pick + the
 * Rust session writer (atomic no-clobber writes). No plugin:fs writes.
 */

test("queue desktop: merge -> one directory pick, session-writer delivery", async ({ page }) => {
  test.setTimeout(180_000);
  await stubTauri(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler("plugin:dialog|open", () => "C:" + String.fromCharCode(92) + "out");
    w.__tauriSetHandler("save_session_begin", () => ({ token: "tok" }));
    w.__tauriSetHandler("save_session_write", (_payload: unknown, options?: unknown) => {
      const name = decodeURIComponent(
        (options as { headers?: { name?: string } } | undefined)?.headers?.name ?? "",
      );
      return { ok: true, path: "C:" + String.fromCharCode(92) + "out" + String.fromCharCode(92) + name };
    });
    w.__tauriSetHandler("save_session_end", () => null);
  });

  await page.goto("./tools/merge");
  await page.getByTestId("queue-toggle").click();
  await page.getByTestId("queue-input").setInputFiles([
    "tests/fixtures/fixture-compare-a.pdf",
    "tests/fixtures/fixture-compare-b.pdf",
  ]);
  await page.getByTestId("queue-add").click();
  await expect(page.getByTestId("queue-item-state")).toContainText("Hoàn tất", { timeout: 90_000 });
  const calls = await readCalls(page);
  const dialogPicks = calls.filter((c) => c.cmd === "plugin:dialog|open").length;
  const fsWrites = calls.filter((c) => c.cmd.startsWith("plugin:fs|")).length;
  expect(dialogPicks).toBe(1);
  expect(fsWrites).toBe(0);
  expect(calls.filter((c) => c.cmd === "save_session_begin").length).toBe(1);
  expect(calls.filter((c) => c.cmd === "save_session_write").length).toBe(1);
  expect(calls.filter((c) => c.cmd === "save_session_end").length).toBe(1);
});
