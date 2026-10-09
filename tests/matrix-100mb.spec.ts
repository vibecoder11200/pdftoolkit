import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { defineMatrix } from './helpers/matrix-def';

/*
 * Nightly-only 100MB tier — SEPARATE FILE from matrix.spec.ts on purpose:
 * vitest's threads pool shares one process heap, and stacking the 100MB
 * fixture (plus every smaller tier) in a single run OOM'd the nightly matrix
 * every night from 2026-10-06 (introduction of the tier) to 2026-10-09.
 * The CI step runs this file in its own vitest invocation with a lifted
 * heap and --no-file-parallelism.
 *
 * tests/fixtures/gen.mjs writes fixture-100mb.pdf ONLY when invoked with
 * --large / MATRIX_100MB=1 / schedule event; the default
 * `node tests/fixtures/gen.mjs` (PR) never creates it, so PR runs cannot
 * pick it up here either: both the env arm AND the file must exist.
 *
 * The fixture loads lazily in beforeAll (NOT at collection — the old
 * collection-time readFileSync kept every tier resident for the whole run)
 * and is released in afterAll.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NIGHTLY_FILE = 'fixture-100mb.pdf';
// Expected pages must match the --large branch of tests/fixtures/gen.mjs.
const NIGHTLY_PAGES = 4500;
const nightlyArmed = env.MATRIX_100MB === '1' || env.GITHUB_EVENT_NAME === 'schedule';

if (nightlyArmed && existsSync(join(fixturesDir, NIGHTLY_FILE))) {
  describe('matrix 100MB [nightly-only]', () => {
    let bytes: Uint8Array | null = null;

    beforeAll(() => {
      bytes = new Uint8Array(readFileSync(join(fixturesDir, NIGHTLY_FILE)));
    });
    afterAll(() => {
      bytes = null; // release before the process lingers on the reporter
    });

    defineMatrix('100MB [nightly-only]', () => bytes!, NIGHTLY_PAGES, 600_000);
  });
} else {
  // Keep the file visible in reports without arming anything (mirrors the
  // tier's "opt-in" contract; PR runs show it skipped, not absent).
  describe.skip('matrix 100MB [nightly-only]', () => {
    it('requires MATRIX_100MB=1 (or schedule) + the --large fixture', () => undefined);
  });
}
