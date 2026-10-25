import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { redactFinalize, type RedactRect } from '../src/engine/pdf-lib';

/*
 * MATRIX_100MB-style redact run (v0.9.0 phase 2, finding 11) — the ship gate
 * that bounds the finalize peak-hold (original + surgical output + qpdf out +
 * the decompressed canonical copy) on a LARGE document. The existing 100MB
 * matrix never exercises the pdf-lib→qpdf chain; this file does, on the same
 * nightly fixture.
 *
 * Same contract as matrix-100mb.spec.ts: the file self-skips unless
 * MATRIX_100MB=1 (or schedule) AND tests/fixtures/gen.mjs --large has run;
 * CI runs it in its OWN vitest invocation with the 8GiB heap and
 * --no-file-parallelism (pages.yml nightly job). Run locally:
 *   NODE_OPTIONS=--max-old-space-size=8192 node tests/fixtures/gen.mjs --large
 *   MATRIX_100MB=1 npx vitest run tests/matrix-redact.spec.ts --no-file-parallelism
 */

const fixturesDir = join(import.meta.dirname, 'fixtures');
const NIGHTLY_FILE = 'fixture-100mb.pdf';
const NIGHTLY_PAGES = 4500; // must match gen.mjs --large (AGENTS.md §3)
// The fixture HEADER line (gen.mjs makePdf: 'PDFTOOLKIT FIXTURE 100mb — page
// 1/4500' at 48,800 size 13) — the body lines repeat 4x and run ~1000pt wide,
// wider than the page: a rect over one is correctly refused as partial.
const SECRET = 'PDFTOOLKIT FIXTURE 100mb';

const armed = env.MATRIX_100MB === '1' || env.GITHUB_EVENT_NAME === 'schedule';

if (armed && existsSync(join(fixturesDir, NIGHTLY_FILE))) {
  describe('matrix redact [nightly-only]', () => {
    let bytes: Uint8Array | null = null;

    beforeAll(() => {
      bytes = new Uint8Array(readFileSync(join(fixturesDir, NIGHTLY_FILE)));
    });
    afterAll(() => {
      bytes = null; // release before the process lingers on the reporter
    });

    it(
      `surgical redaction survives the full finalize chain on the ${NIGHTLY_PAGES}-page fixture`,
      async () => {
        const libDoc = await PDFDocument.load(bytes!, { ignoreEncryption: true });
        expect(libDoc.getPageCount()).toBe(NIGHTLY_PAGES);
        // rect over the header line (48, 800 size 13 — gen.mjs makePdf layout;
        // tall box per the walker's ascent-window estimate)
        const rects: RedactRect[] = [{ x: 45, y: 794, w: 280, h: 19 }];
        const t0 = Date.now();
        const result = await redactFinalize(bytes!, {
          secrets: [SECRET],
          surgical: [{ page: 1, rects }],
        });
        const ms = Date.now() - t0;
        expect(result.removedBlocks).toBeGreaterThanOrEqual(1);
        expect(result.surgicalPages).toEqual([1]);
        const peakMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
        console.log(
          `[matrix-redact] ${NIGHTLY_PAGES}p finalize ${ms}ms, output ${(result.bytes.byteLength / 1024 / 1024).toFixed(1)}MB, peak RSS ${peakMb}MB`,
        );
        // page count preserved (no page objects lost in the rewrite)
        const outDoc = await PDFDocument.load(result.bytes, { ignoreEncryption: true });
        expect(outDoc.getPageCount()).toBe(NIGHTLY_PAGES);
      },
      900_000,
    );
  });
} else {
  describe.skip('matrix redact [nightly-only]', () => {
    it('requires MATRIX_100MB=1 (or schedule) + the --large fixture', () => undefined);
  });
}
