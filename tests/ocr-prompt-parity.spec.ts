/*
 * OCR prompt parity gate (v0.7.0 phase 2). The native engine's locked prompt
 * (src-tauri/src/native_engine/ocr.rs OCR_PROMPT) and the web worker's twin
 * (src/workers/ai-ocr.worker.ts OCR_PROMPT) MUST stay byte-identical — the
 * v0.6.0 parity invariant previously had zero enforcement and drifts
 * silently. This spec reads BOTH sources as text and extracts the literals,
 * so an edit on either side that breaks parity (or drops the constant
 * entirely) fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

function extractRustPrompt(src: string): string | null {
  const m = /pub const OCR_PROMPT: &str\s*=\s*"([^"]*)"/.exec(src);
  return m?.[1] ?? null;
}

function extractWorkerPrompt(src: string): string | null {
  const m = /const OCR_PROMPT\s*=\s*\n?\s*'([^']*)'/.exec(src);
  return m?.[1] ?? null;
}

describe('ocr prompt parity', () => {
  it('native OCR_PROMPT and web worker prompt are byte-identical', () => {
    const rust = readFileSync(join(root, 'src-tauri/src/native_engine/ocr.rs'), 'utf8');
    const worker = readFileSync(join(root, 'src/workers/ai-ocr.worker.ts'), 'utf8');
    const rustPrompt = extractRustPrompt(rust);
    const workerPrompt = extractWorkerPrompt(worker);
    expect(rustPrompt, 'OCR_PROMPT missing from ocr.rs').toBeTruthy();
    expect(workerPrompt, 'OCR_PROMPT missing from ai-ocr.worker.ts').toBeTruthy();
    expect(rustPrompt).toBe(workerPrompt);
  });
});
