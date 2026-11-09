import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pdf2WordPageCapError, runPdf2Word } from '../src/lib/pdf2word';
import { getVisualTextItems } from '../src/engine/pdfjs';

/*
 * Nightly-only pdf2word leg over the 100MB fixture (v0.10.2 phase 2, plan
 * 261109-1101 — pays the journaled v0.10.x deferral). Same contract as the
 * PR-tier leg in matrix.spec.ts: whole pipeline (extraction → layout →
 * markdown → DOCX emitter stub), mode assertion, bigger fixture.
 *
 * Runs in its OWN vitest process (mirrors matrix-100mb.spec.ts — the
 * threads pool shares one heap; the CI step lifts it to 8GiB and disables
 * file parallelism). tests/fixtures/gen.mjs writes fixture-100mb.pdf ONLY
 * when invoked with --large / MATRIX_100MB=1 / schedule.
 *
 * RED-TEAM F1: the --large fixture is 4500 pages and runPdf2Word refuses
 * anything above its 100-page cap, so the leg SAMPLES first/middle/last and
 * drives the pipeline over that selection (queue-relative pages [1,2,3]).
 * The cap itself is asserted separately below on the same fixture class
 * (mocked extract — the cap fires before any extraction runs).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NIGHTLY_FILE = 'fixture-100mb.pdf';
// Expected pages must match the --large branch of tests/fixtures/gen.mjs.
const NIGHTLY_PAGES = 4500;
const nightlyArmed = env.MATRIX_100MB === '1' || env.GITHUB_EVENT_NAME === 'schedule';
const SAMPLE = [1, Math.ceil(NIGHTLY_PAGES / 2), NIGHTLY_PAGES];

if (nightlyArmed && existsSync(join(fixturesDir, NIGHTLY_FILE))) {
  describe('matrix pdf2word 100MB [nightly-only]', () => {
    let bytes: Uint8Array | null = null;

    beforeAll(() => {
      bytes = new Uint8Array(readFileSync(join(fixturesDir, NIGHTLY_FILE)));
    });
    afterAll(() => {
      bytes = null; // release before the process lingers on the reporter
    });

    it('converts sampled first/middle/last pages end-to-end', async () => {
      const res = await runPdf2Word({
        pageCount: SAMPLE.length,
        pages: [1, 2, 3],
        extractPage: (q) => getVisualTextItems(bytes!, SAMPLE[q - 1]!),
        toDocx: async (pages) => new TextEncoder().encode(pages.texts.join('\n\n')),
      });
      expect(res.mode).toBe('digital');
      for (const md of res.markdown) expect(md.length).toBeGreaterThan(0);
      expect(res.docx.length).toBeGreaterThan(0);
    }, 600_000);

    it('still refuses above the 100-page cap on this fixture class', async () => {
      await expect(
        runPdf2Word({
          pageCount: NIGHTLY_PAGES + 1,
          extractPage: async () => [],
          toDocx: async () => new Uint8Array(),
        }),
      ).rejects.toThrow(Pdf2WordPageCapError);
    });
  });
} else {
  // Keep the file visible in reports without arming anything (mirrors the
  // tier's "opt-in" contract; PR runs show it skipped, not absent).
  describe.skip('matrix pdf2word 100MB [nightly-only]', () => {
    it('requires MATRIX_100MB=1 (or schedule) + the --large fixture', () => undefined);
  });
}
