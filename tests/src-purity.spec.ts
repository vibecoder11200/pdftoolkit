import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * src-purity guard (v0.6.0 phase 6, R6.5/review M3): tsconfig.json is a
 * SINGLE project (include: [src, tests], no references) — tsc does NOT
 * enforce the src/tests boundary, and vite excluding tests/ from builds is
 * a construction fact, not a gate. This spec IS the gate: no production
 * file may import from the test tree (which includes the Tauri mock seam).
 */

const SRC_ROOT = join(import.meta.dirname, '..', 'src');
const IMPORT_TESTS = /from\s+['"](.*\/)?(tests|test|__tests__)(\/|['"])/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) yield full;
  }
}

describe('src purity — production code never imports the test tree', () => {
  it('no file under src/ imports from tests/', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const raw = readFileSync(file, 'utf8');
      if (IMPORT_TESTS.test(raw)) offenders.push(file);
    }
    expect(offenders, `these production files import from tests/: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });
});
