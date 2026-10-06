import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLinearizeAcceptableExit, linearizePdf } from '../src/engine/qpdf';
import { pageCountOf } from './helpers/text-assert';

// Linearize (fast web view) — qpdf --linearize. Semantics under test:
// clean input exits 0, damaged-xref input exits 3 with a repaired (valid)
// output that we still accept (red-team #14). Both outputs must reopen in
// pdf.js with the original page count and carry the /Linearized marker.

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture1mb = () => new Uint8Array(readFileSync(join(fixturesDir, 'fixture-small.pdf')));

const hasLinearizedMarker = (bytes: Uint8Array) =>
  new TextDecoder('latin1').decode(bytes).includes('/Linearized');

describe('linearizePdf', () => {
  it('marks output /Linearized and keeps the page count', async () => {
    const src = fixture1mb();
    const out = await linearizePdf(src);
    expect(hasLinearizedMarker(out)).toBe(true);
    expect(await pageCountOf(out)).toBe(2);
  });

  it('accepts warning exit 3 and 0, rejects error exits (red-team #14 seam)', () => {
    // The wasm build empirically escalates repairable xref damage to exit 2
    // (probed: truncated xref, corrupt offsets, wrong startxref), so the
    // 0/3-vs-error boundary is pinned here rather than via a synthetic
    // warning file. linearizePdf throws on everything this rejects.
    expect(isLinearizeAcceptableExit(0)).toBe(true);
    expect(isLinearizeAcceptableExit(3)).toBe(true);
    expect(isLinearizeAcceptableExit(undefined)).toBe(true);
    expect(isLinearizeAcceptableExit(1)).toBe(false);
    expect(isLinearizeAcceptableExit(2)).toBe(false);
  });

  it('rejects non-PDF garbage instead of "linearizing" it', async () => {
    const garbage = new TextEncoder().encode('definitely not a pdf');
    await expect(linearizePdf(garbage)).rejects.toThrow(/qpdf exit/);
  });
});
