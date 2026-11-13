import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  QpdfRepairRefusedError,
  qpdfInspectRaw,
  qpdfRepairRaw,
} from "../src/engine/qpdf";
import { RepairRefusedError, runRepair } from "../src/lib/pdf-repair";
import { sanitizeQpdfLines } from "../src/lib/pdf-diagnostics";
import { encryptPdf } from "../src/engine/qpdf";
import { pageCountOf } from "./helpers/text-assert";

/*
 * Phase-8 diagnostics/repair suite. Pins the ACTUAL qpdf-wasm matrix from
 * the spike (plans/.../reports/qpdf-diagnostic-spike.md) and the repair
 * validation contract: refusal (no output) on unrecoverable inputs, signed
 * refusal BEFORE any mutation, page/text parity when the original is
 * readable, honest "unverifiable" marking otherwise.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const healthy = () => new Uint8Array(readFileSync(join(fixturesDir, "fixture-small.pdf")));

const truncated = () => healthy().slice(0, Math.floor(healthy().length * 0.55));

const startxrefCorrupt = () => {
  const s = Buffer.from(healthy()).toString("latin1");
  const i = s.lastIndexOf("startxref");
  const j = s.indexOf("\n", i);
  const k = s.indexOf("\n", j + 1);
  return new Uint8Array(Buffer.from(s.slice(0, j + 1) + "99999999" + s.slice(k), "latin1"));
};

describe("qpdf --check matrix (actual wasm)", () => {
  it("healthy exits 0", async () => {
    expect((await qpdfInspectRaw(healthy())).exitCode).toBe(0);
  });
  it("truncated exits 2", async () => {
    expect((await qpdfInspectRaw(truncated())).exitCode).toBe(2);
  });
  it("startxref-corrupt exits 2", async () => {
    expect((await qpdfInspectRaw(startxrefCorrupt())).exitCode).toBe(2);
  });
  it("not-a-pdf exits 2", async () => {
    expect((await qpdfInspectRaw(new TextEncoder().encode("not a pdf at all"))).exitCode).toBe(2);
  });
  it("encrypted without password exits 2 and says invalid password", async () => {
    const enc = await encryptPdf(healthy(), "spark", "spark", 256);
    const r = await qpdfInspectRaw(enc);
    expect(r.exitCode).toBe(2);
    expect(r.lines.join("\n")).toMatch(/invalid password/i);
  });
  it("encrypted WITH password exits 0 (decrypt leg, never stripped silently)", async () => {
    const enc = await encryptPdf(healthy(), "spark", "spark", 256);
    const r = await qpdfRepairRaw(enc, "spark");
    expect(r.exitCode).toBe(0);
    expect(await pageCountOf(r.bytes)).toBe(2);
  });
});

describe("qpdf repair raw (new output only)", () => {
  it("healthy repair produces a parseable 2-page output", async () => {
    const r = await qpdfRepairRaw(healthy());
    expect(r.bytes.byteLength).toBeGreaterThan(0);
    expect(await pageCountOf(r.bytes)).toBe(2);
  });
  it("garbage-appended input repairs to the same page count", async () => {
    const b = new Uint8Array(healthy().length + 128);
    b.set(healthy(), 0);
    for (let i = 0; i < 128; i++) b[healthy().length + i] = (i * 53 + 7) & 255;
    const r = await qpdfRepairRaw(b);
    expect(await pageCountOf(r.bytes)).toBe(2);
  });
  it("truncated input REFUSES with no output (exit 2)", async () => {
    await expect(qpdfRepairRaw(truncated())).rejects.toThrow(QpdfRepairRefusedError);
  });
  it("startxref-corrupt input REFUSES", async () => {
    await expect(qpdfRepairRaw(startxrefCorrupt())).rejects.toThrow(QpdfRepairRefusedError);
  });
  it("encrypted without password REFUSES (no silent stripping)", async () => {
    const enc = await encryptPdf(healthy(), "spark", "spark", 256);
    await expect(qpdfRepairRaw(enc)).rejects.toThrow(QpdfRepairRefusedError);
  });
});

describe("repair composition (injected legs)", () => {
  const okBytes = new Uint8Array([1, 2, 3]);
  const mkDeps = (over: Partial<Parameters<typeof runRepair>[3]> = {}) => ({
    hasSignature: async () => false,
    repair: async () => ({ bytes: okBytes, exitCode: 0, lines: [] }),
    pageCount: async () => 2,
    firstPageText: async () => "hello",
    ...over,
  });

  it("verifies when pages + first-page text match", async () => {
    const r = await runRepair(healthy(), "tai-lieu.pdf", undefined, mkDeps({
      repair: async () => ({ bytes: new Uint8Array([9, 9]), exitCode: 3, lines: ["warn kept"] }),
      pageCount: async () => 2,
      firstPageText: async () => "hello",
    }));
    expect(r.verification).toBe("verified");
    expect(r.filename).toBe("tai-lieu-sua-chua.pdf");
    expect(r.warnings).toEqual(["warn kept"]);
  });

  it("refuses on page-count mismatch", async () => {
    await expect(
      runRepair(healthy(), "a.pdf", undefined, mkDeps({ pageCount: async (b) => (b[0] === 37 ? 5 : 2) })),
    ).rejects.toThrow(RepairRefusedError);
  });

  it("refuses on first-page text mismatch", async () => {
    await expect(
      runRepair(healthy(), "a.pdf", undefined, mkDeps({ firstPageText: async (b) => (b[0] === 37 ? "orig-text" : "out-text") })),
    ).rejects.toThrow(RepairRefusedError);
  });

  it("marks unverifiable when the original is unreadable (no parity claim)", async () => {
    const r = await runRepair(healthy(), "a.pdf", undefined, mkDeps({
      pageCount: async (b) => (b[0] === 37 ? Promise.reject(new Error("unreadable")) : 2),
      firstPageText: async (b) => (b[0] === 37 ? Promise.reject(new Error("unreadable")) : "x"),
    }));
    expect(r.verification).toBe("unverifiable");
  });

  it("refuses SIGNED input before any repair call", async () => {
    const repair = vi.fn(async () => ({ bytes: okBytes, exitCode: 0, lines: [] }));
    await expect(
      runRepair(healthy(), "a.pdf", undefined, mkDeps({ hasSignature: async () => true, repair })),
    ).rejects.toThrow(/signed-input/);
    expect(repair).not.toHaveBeenCalled();
  });

  it("refuses empty engine output", async () => {
    await expect(
      runRepair(healthy(), "a.pdf", undefined, mkDeps({ repair: async () => ({ bytes: new Uint8Array(0), exitCode: 0, lines: [] }) })),
    ).rejects.toThrow(/empty-output/);
  });
});

describe("sanitizeQpdfLines", () => {
  it("strips argv0 prefix + tmp paths, dedupes, bounds", () => {
    const raw = [
      "pdf.worker.js: /tmp/pdftoolkit-1-in.pdf: unexpected end of xref stream",
      "pdf.worker.js: /tmp/pdftoolkit-1-in.pdf: unexpected end of xref stream",
      "  ", // dropped (empty)
    ];
    for (let i = 0; i < 12; i++) raw.push("extra line " + i + " padding pad pad");
    const out = sanitizeQpdfLines(raw);
    expect(out[0]).toBe("<tmp>: unexpected end of xref stream");
    expect(out.length).toBeLessThanOrEqual(8);
    expect(new Set(out).size).toBe(out.length);
  });
});
