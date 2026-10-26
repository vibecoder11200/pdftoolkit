/*
 * DOCX export (v0.7.0 phase 4) — node-side. The builder runs its real
 * pipeline (markdown → whitelist HTML → docx/html → Packer); the oracle is
 * the unzipped word/document.xml: Word heading styles, header-semantics
 * tables, native OMML equations with the literal-text fallback, page
 * breaks, and the tesseract flat path.
 */
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { markdownToDocx } from '../src/lib/markdown-docx';
import { mathSafe } from '../src/lib/ai-markdown';

async function documentXml(pages: Parameters<typeof markdownToDocx>[0]): Promise<string> {
  const bytes = await markdownToDocx(pages);
  const files = unzipSync(bytes);
  return new TextDecoder().decode(files['word/document.xml']);
}

describe('markdownToDocx (AI path)', () => {
  it('renders headings, header-tables, native math, and page breaks', async () => {
    const xml = await documentXml({
      texts: [
        '# BÁO CÁO TỒN KHO\n\n| Mã hàng | Thành tiền (VND) |\n| --- | --- |\n| BT-031 | 12.450.000 |\n\nTổng: $\\frac{a}{b}$',
        '## Trang hai',
      ],
    });
    expect(xml).toMatch(/w:pStyle w:val="Heading1"/);
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:tblHeader/>');
    // LaTeX → native Word equation (OMML).
    expect(xml).toContain('<m:oMath>');
    // Page break between the two pages.
    expect(xml).toContain('<w:pageBreakBefore/>');
    // Vietnamese survived byte-correct.
    expect(xml).toContain('BÁO CÁO TỒN KHO');
  });

  it('unknown LaTeX falls back to the literal source (never fails the export)', async () => {
    // htmlToContent's invalid-math path keeps the LaTeX WITHOUT delimiters
    // as a plain text run — the export survives, the source stays readable.
    const xml = await documentXml({ texts: ['Công thức: $\\foo{bar}$ kết thúc'] });
    expect(xml).not.toContain('<m:oMath>');
    expect(xml).toContain('\\foo{bar}');
  });

  it('unbalanced dollar stays literal and deep-nesting LaTeX never reaches the converter', async () => {
    expect(mathSafe('')).toBe(false);
    expect(mathSafe('x'.repeat(501))).toBe(false);
    expect(mathSafe('{'.repeat(11) + 'x')).toBe(false);
    expect(mathSafe('\\frac{a}{b}')).toBe(true);
    const deep = `${'{'.repeat(30)}x${'}'.repeat(30)}`;
    // Separate LINES: $-pairing never crosses a newline, so the currency
    // '$' and the math '$...$' cannot mispair.
    const xml = await documentXml({
      texts: ['Giá 5$ mỗi cái', `$${deep}$`],
    });
    expect(xml).not.toContain('<m:oMath>');
    // The literal sources survive as plain text runs.
    expect(xml).toContain('Giá 5$ mỗi cái');
  });
});

describe('markdownToDocx (tesseract path)', () => {
  it('emits flat paragraphs with a page break between pages', async () => {
    const xml = await documentXml({ texts: ['Trang một dòng A\nTrang một dòng B', 'Trang hai dòng'], flat: true });
    expect(xml).toContain('Trang một dòng A');
    expect(xml).toContain('Trang một dòng B');
    expect(xml).toContain('Trang hai dòng');
    expect(xml).toContain('<w:pageBreakBefore/>');
    // Flat mode must NOT create heading styles or tables.
    expect(xml).not.toMatch(/w:pStyle w:val="Heading/);
    expect(xml).not.toContain('<w:tbl>');
  });

  it('rejects an empty page list', async () => {
    await expect(markdownToDocx({ texts: [] })).rejects.toThrow('no pages');
  });
});

describe('markdownToDocx table/list fidelity (v0.9.0 phase 9)', () => {
  it('tables render borders, header shading, and cell padding', async () => {
    const xml = await documentXml({
      texts: ['# Bảng\n\n| Tên | Số |\n| --- | --- |\n| A | 1 |\n| B | 2 |'],
    });
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:tblBorders>'); // visible grid
    expect(xml).toMatch(/<w:shd[^>]*w:fill="F2F2F2"/); // header-row shading
    expect(xml).toMatch(/w:w="\d+"/); // padding via cell margins/width
  });

  it('nested bullets emit real w:ilvl levels (not a flat list)', async () => {
    const xml = await documentXml({
      texts: ['- item 1\n  - nested 1.1\n    - deep 1.1.1\n- item 2'],
    });
    expect(xml).toMatch(/w:ilvl w:val="1"/);
    expect(xml).toMatch(/w:ilvl w:val="2"/);
    expect(xml).toContain('deep 1.1.1');
    expect(xml).toContain('item 2');
  });

  it('mixed ordered/bullet lists keep their numberings', async () => {
    const xml = await documentXml({
      texts: ['1. first\n   - sub\n2. second'],
    });
    expect(xml).toMatch(/w:numId w:val="\d+"/); // both lists carry numbering
    expect(xml).toMatch(/w:ilvl w:val="1"/);
    expect(xml).toContain('second');
  });
});
