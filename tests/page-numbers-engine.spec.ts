import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPageNumbers } from '../src/engine/pdf-lib';
import { basenameSansExt, formatDateVi, renderPageTemplate } from '../src/lib/page-template';

/*
 * Page numbers engine (v0.8.0 phase 1): token renderer unit matrix (pure
 * module — zero pdf-lib imports, asserted by the grep gate in review) plus
 * applyPageNumbers end-to-end through the pdf.js extraction oracle (same
 * legacy-build pattern as tests/watermark-engine.spec.ts).
 */
const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const ROBOTO = join(import.meta.dirname, '..', 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

async function pdfjsLegacy() {
  const require = createRequire(import.meta.url);
  return require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
}

async function extractPageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const tc = await page.getTextContent();
    return tc.items.map((i) => ('str' in i ? String(i.str) : '')).join(' ');
  } finally {
    await task.destroy();
  }
}

describe('renderPageTemplate (pure token renderer)', () => {
  const ctx = { n: 3, total: 12, filename: 'hợp đồng 2026.pdf' };

  it('resolves every token', () => {
    expect(renderPageTemplate('{n}', ctx)).toBe('3');
    expect(renderPageTemplate('{total}', ctx)).toBe('12');
    expect(renderPageTemplate('{filename}', ctx)).toBe('hợp đồng 2026');
    expect(renderPageTemplate('{date}', ctx)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('joins tokens with surrounding literals', () => {
    expect(renderPageTemplate('Trang {n}/{total}', ctx)).toBe('Trang 3/12');
    expect(renderPageTemplate('{n} — {filename}', ctx)).toBe('3 — hợp đồng 2026');
  });

  it('startNumber offset is applied by the caller (n = page + start − 1)', () => {
    expect(renderPageTemplate('{n}', { ...ctx, n: 2 + 5 - 1 })).toBe('6');
  });

  it('unknown tokens pass through literally', () => {
    expect(renderPageTemplate('{pg} {n} {unknown}', ctx)).toBe('{pg} 3 {unknown}');
  });

  it('explicit date overrides the device clock', () => {
    expect(renderPageTemplate('{date}', { ...ctx, date: '01/02/2026' })).toBe('01/02/2026');
  });

  it('formatDateVi pads dd/mm', () => {
    expect(formatDateVi(new Date(2026, 0, 9))).toBe('09/01/2026');
    expect(formatDateVi(new Date(2026, 11, 31))).toBe('31/12/2026');
  });

  it('basenameSansExt strips directories and the extension', () => {
    expect(basenameSansExt('a/b/c.pdf')).toBe('c');
    expect(basenameSansExt('C:\\dir\\tài liệu.PDF')).toBe('tài liệu');
    expect(basenameSansExt(undefined)).toBe('');
    expect(basenameSansExt('noext')).toBe('noext');
  });
});

describe('applyPageNumbers (pdf.js oracle)', () => {
  const bytes = () => new Uint8Array(readFileSync(fx('fixture-pagenums.pdf')));

  it('numbers every page "Trang n/total" bottom-center', async () => {
    const out = await applyPageNumbers(bytes(), {
      template: 'Trang {n}/{total}',
      position: 'bottom-center',
      margin: 36,
      fontSize: 12,
      startNumber: 1,
      filename: 'fixture-pagenums.pdf',
    }, robotoBytes());
    for (let p = 1; p <= 5; p += 1) {
      expect(await extractPageText(out, p), `page ${p}`).toContain(`Trang ${p}/5`);
    }
  }, 30_000);

  it('skip-first scope (pages 2..5) leaves page 1 clean', async () => {
    const out = await applyPageNumbers(bytes(), {
      template: 'Trang {n}/{total}',
      position: 'bottom-center',
      margin: 36,
      fontSize: 12,
      startNumber: 1,
      pages: [2, 3, 4, 5],
      filename: 'fixture-pagenums.pdf',
    }, robotoBytes());
    expect(await extractPageText(out, 1)).not.toContain('Trang 1/5');
    expect(await extractPageText(out, 2)).toContain('Trang 2/5');
    expect(await extractPageText(out, 5)).toContain('Trang 5/5');
  });

  it('startNumber offsets {n} while {total} stays the full count', async () => {
    const out = await applyPageNumbers(bytes(), {
      template: '{n}+{total}',
      position: 'bottom-center',
      margin: 36,
      fontSize: 12,
      startNumber: 10,
      filename: 'fixture-pagenums.pdf',
    }, robotoBytes());
    expect(await extractPageText(out, 1)).toContain('10+5');
    expect(await extractPageText(out, 5)).toContain('14+5');
  });

  it('{filename} resolves the basename sans extension', async () => {
    const out = await applyPageNumbers(bytes(), {
      template: '{filename} — {n}',
      position: 'bottom-center',
      margin: 36,
      fontSize: 12,
      startNumber: 1,
      filename: 'deep/dir/báo cáo.pdf',
    }, robotoBytes());
    expect(await extractPageText(out, 1)).toContain('báo cáo — 1');
  });

  it('refuses encrypted input with the typed error the UI routes to decrypt', async () => {
    const locked = new Uint8Array(readFileSync(fx('fixture-locked.pdf')));
    await expect(
      applyPageNumbers(locked, {
        template: '{n}',
        position: 'bottom-center',
        margin: 36,
        fontSize: 12,
        startNumber: 1,
        filename: 'x.pdf',
      }, robotoBytes()),
    ).rejects.toThrow(/encrypted/i);
  });
});
