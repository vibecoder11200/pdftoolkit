/*
 * Searchable-PDF sandwich (v0.7.0 phase 3) — node-side integration spec.
 * The builder runs with an @napi-rs/canvas render seam (the browser path is
 * exercised by the download-intercept e2e); the pdf.js oracle asserts the
 * INVISIBLE layer: page count == results, per-page display text with
 * byte-correct Vietnamese diacritics, size budget. Markdown-syntax display
 * normalization (headings/tables/math delimiters) is pinned here too.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';

import { buildSandwichPdf, displayLines } from '../src/lib/ocr-sandwich';
import { getPageText, pageCountOf } from './helpers/text-assert';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');

const FIXTURE = join(__dirname, 'fixtures/ocr-scan-vn-en.pdf');
const ROBOTO = new Uint8Array(
  readFileSync(join(__dirname, '../src/assets/fonts/Roboto-Regular.ttf')),
);

/** The node render seam: pdf.js legacy + @napi-rs/canvas at quality.dpi. */
async function renderPageJpegNode(
  sourceBytes: Uint8Array,
  page: number,
  dpi: number,
): Promise<Uint8Array> {
  const loadingTask = legacy.getDocument({ data: sourceBytes.slice() });
  const doc = await loadingTask.promise;
  try {
    const p = await doc.getPage(page);
    const viewport = p.getViewport({ scale: dpi / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    return new Uint8Array(await canvas.encode('jpeg', 0.75));
  } finally {
    await loadingTask.destroy();
  }
}

describe('displayLines normalizer', () => {
  it('strips heading markers, drops table separator rows, space-joins cells, unescapes pipes', () => {
    const md = [
      '# BÁO CÁO TỒN KHO',
      '',
      '## Khu vực phía Bắc',
      '| Mã hàng | Thành tiền (VND) |',
      '| --- | --- |',
      '| BT-031 | 12.450.000 |',
      '| a \\| b | c |',
      'Ghi chú: **đậm** và `code` và $x^2$',
    ].join('\n');
    expect(displayLines(md)).toEqual([
      'BÁO CÁO TỒN KHO',
      'Khu vực phía Bắc',
      'Mã hàng Thành tiền (VND)',
      'BT-031 12.450.000',
      'a | b c',
      'Ghi chú: đậm và code và x^2',
    ]);
  });

  it('keeps stray dollar signs and plain text untouched', () => {
    expect(displayLines('Giá: 5$ mỗi cái')).toEqual(['Giá: 5$ mỗi cái']);
    expect(displayLines('$$\\frac{a}{b}$$')).toEqual(['\\frac{a}{b}']);
  });
});

describe('buildSandwichPdf', () => {
  const pages = [
    {
      index: 1,
      displayText: 'Quarterly report\ntotal 42,518 items processed\nTiếng Việt: ơ ư ạ ế ầ — Đường Hà Nội',
    },
    {
      index: 2,
      displayText:
        '# Đặng Thị Thu Lĩnh\n| Mã hàng | Thành tiền (VND) |\n| --- | --- |\n| BT-031 | 12.450.000 |\nĐiện thoại: 0912 345 678',
    },
  ];

  it('sandwiches the raster with an invisible byte-correct text layer at 150 DPI', async () => {
    const source = new Uint8Array(readFileSync(FIXTURE));
    const bytes = await buildSandwichPdf(
      source,
      pages,
      { dpi: 150 },
      { renderPageJpeg: renderPageJpegNode, robotoBytes: ROBOTO },
    );
    expect(await pageCountOf(bytes)).toBe(pages.length);

    // Page 1: plain display text incl. the full Vietnamese diacritic set —
    // byte-correct through pdf.js extraction (the WinAnsi tripwire).
    const p1 = await getPageText(bytes, 1);
    for (const line of pages[0].displayText.split('\n')) {
      expect(p1).toContain(line);
    }

    // Page 2: markdown syntax must NOT leak into the extracted layer — the
    // heading marker and table pipes are normalized to display text.
    const p2 = await getPageText(bytes, 2);
    expect(p2).toContain('Đặng Thị Thu Lĩnh');
    expect(p2).not.toContain('#');
    expect(p2).toContain('Mã hàng Thành tiền (VND)');
    expect(p2).toContain('BT-031 12.450.000');
    expect(p2).toContain('Điện thoại: 0912 345 678');

    // Size budget: 150 DPI JPEG q75 ≈ 110 KB/page → < 250 KB/page.
    expect(bytes.length / pages.length).toBeLessThan(250_000);
  });

  it('archive quality (300 DPI) stays searchable and page count matches', async () => {
    const source = new Uint8Array(readFileSync(FIXTURE));
    const bytes = await buildSandwichPdf(
      source,
      [pages[0]],
      { dpi: 300 },
      { renderPageJpeg: renderPageJpegNode, robotoBytes: ROBOTO },
    );
    expect(await pageCountOf(bytes)).toBe(1);
    const p1 = await getPageText(bytes, 1);
    expect(p1).toContain('Tiếng Việt: ơ ư ạ ế ầ — Đường Hà Nội');
  });

  it('rejects an empty page list', async () => {
    const source = new Uint8Array(readFileSync(FIXTURE));
    await expect(
      buildSandwichPdf(source, [], { dpi: 150 }, { renderPageJpeg: renderPageJpegNode, robotoBytes: ROBOTO }),
    ).rejects.toThrow('no pages');
  });
});
