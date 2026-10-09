import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { defineMatrix } from './helpers/matrix-def';

/*
 * Phase 6 test matrix (PR tier): fixtures 1MB + 10MB x every P0 tool path
 * reachable from src/engine/client.ts.
 * The client itself is a thin Worker proxy (Client.ts re-exports WorkerApi),
 * and WorkerApi delegates 1:1 to these same pdf-lib/qpdf functions, so the
 * matrix imports them directly exactly like tests/engine.spec.ts does —
 * Node/vitest has no Web Worker, and this keeps the engine-suite pattern.
 * NOTE (reachability): `metadata` (src/components/workspace/metadata-tool.tsx
 * drives pdf-lib setTitle/setAuthor/... directly, no engine import) and the
 * image-sign embed (src/components/workspace/sign-tool.tsx embedPng/drawImage
 * via pdf-lib; its only engine call is loadPdf) expose NO method on
 * src/engine/client.ts, so they have no matrix row here. Covered below is
 * everything the client exposes: loadPdf, merge(Pdfs/Selected), splitRanges,
 * extract, remove, reorder, rotate, compressVectorPack, encrypt+decrypt,
 * qpdfCheck. The 100MB tier lives in matrix-100mb.spec.ts (separate FILE and
 * CI step — one-process stacking OOM'd the nightly run 4 nights running).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface FixtureCase {
  label: string;
  file: string;
  pages: number;
}

// Page counts mirror tests/fixtures/gen.mjs: makePdf(2, '1mb', 40) and
// makePdf(40, '10mb', 60).
const PR_CASES: FixtureCase[] = [
  { label: 'small', file: 'fixture-small.pdf', pages: 2 },
  { label: 'medium', file: 'fixture-medium.pdf', pages: 40 },
];

for (const c of PR_CASES) {
  describe(`matrix ${c.label}`, () => {
    const bytes = new Uint8Array(readFileSync(join(fixturesDir, c.file)));
    defineMatrix(c.label, () => bytes, c.pages, 120_000);
  });
}
