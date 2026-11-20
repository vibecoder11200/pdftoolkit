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

/*
 * v0.13.0 phase 4: the queue panel's organize op (many→one) delivers ONE
 * merged artifact through the session writer — with outline carry-over
 * riding along (source 2 carries bookmarks.pdf's tree, offset-remapped).
 */
test("queue desktop: organize -> one pick, one session-writer write", async ({ page }) => {
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
  await page.getByTestId("queue-op-select").selectOption("organize");
  await page.getByTestId("queue-input").setInputFiles([
    "tests/fixtures/fixture-compare-a.pdf",
    "tests/fixtures/bookmarks.pdf",
  ]);
  await page.getByTestId("queue-add").click();
  await expect(page.getByTestId("queue-item-state")).toContainText("Hoàn tất", { timeout: 90_000 });
  const calls = await readCalls(page);
  expect(calls.filter((c) => c.cmd === "plugin:dialog|open").length).toBe(1);
  expect(calls.filter((c) => c.cmd.startsWith("plugin:fs|")).length).toBe(0);
  expect(calls.filter((c) => c.cmd === "save_session_begin").length).toBe(1);
  const writes = calls.filter((c) => c.cmd === "save_session_write");
  expect(writes).toHaveLength(1);
  const headers = (writes[0]?.options as { headers?: { name?: string } } | undefined)?.headers;
  expect(headers?.name).toBe("2-file-tap-hop-giu-dau-trang.pdf");
  expect(calls.filter((c) => c.cmd === "save_session_end").length).toBe(1);
});
