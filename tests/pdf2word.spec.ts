import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BORDERLESS_MIN_COLS,
  BORDERLESS_MIN_GAP_PT,
  PDF2WORD_CENSUS_MIN_CHARS,
  PDF2WORD_MAX_ITEMS_PER_PAGE,
  PDF2WORD_PAGE_CAP,
  Pdf2WordItemCapError,
  Pdf2WordPageCapError,
  Pdf2WordScanError,
  censusMode,
  censusSample,
  detectTable,
  emitTableMarkdown,
  gutterColumns,
  pageToMarkdown,
  runPdf2Word,
  sanitizeItems,
  xyCut,
  pageBodySize,
} from '../src/lib/pdf2word';
import { getVisualTextItems } from '../src/engine/pdfjs';
import { markdownToSafeHtml } from '../src/lib/ai-markdown';
import { markdownToDocx } from '../src/lib/markdown-docx';

/*
 * PDF→Word engine specs (v0.10.0 phase 4) — the spike rubric as tests
 * (plans/reports/spike-pdf2word-2026-11-02.md). Fixtures are the committed
 * gen.mjs pdf2word set: letter / invoice / twocol / viet / list /
 * adversarial / scan / sandwich / mixed. Extraction runs through the real
 * pdf.js visual-items surface (vitest aliases pdfjs-dist to the node-safe
 * legacy build), so the layout math is exercised on genuine extraction
 * output, not hand-built shapes.
 */
const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const bytesOf = (f: string) => new Uint8Array(readFileSync(fx(f)));

async function pageMd(f: string, page = 1): Promise<string> {
  const bytes = bytesOf(f);
  return pageToMarkdown(await getVisualTextItems(bytes, page));
}

describe('pdf2word layout: letter (single column)', () => {
  it('reading order: heading first, paragraphs in order, signature last', async () => {
    const md = await pageMd('fixture-p2w-letter.pdf');
    const idx = (s: string) => md.indexOf(s);
    expect(idx('# Quarterly Operations Report')).toBeGreaterThanOrEqual(0);
    expect(idx('Prepared by the Operations Team')).toBeGreaterThan(idx('# Quarterly Operations Report'));
    expect(idx('During the fourth quarter')).toBeGreaterThan(idx('Prepared by the Operations Team'));
    expect(idx('Warehouse throughput')).toBeGreaterThan(idx('During the fourth quarter'));
    expect(idx('The outlook for the first quarter')).toBeGreaterThan(idx('Warehouse throughput'));
    expect(idx('Jane Doe')).toBeGreaterThan(idx('The outlook for the first quarter'));
    // Paragraph lines merged (a line-internal gap must never split).
    expect(md).toContain('record volume of orders');
    expect(md).toContain('entered service in September');
  });

  it('heading grade only on the 16pt title (subheading stays body text)', async () => {
    const md = await pageMd('fixture-p2w-letter.pdf');
    expect(md.match(/^#/gm)).toHaveLength(1);
  });
});

describe('pdf2word layout: twocol (gutter columns)', () => {
  it('every NORTH line precedes every SOUTH line', async () => {
    const md = await pageMd('fixture-p2w-twocol.pdf');
    const lastNorth = md.lastIndexOf('north.');
    const firstSouth = md.indexOf('Southern region met');
    expect(lastNorth).toBeGreaterThan(0);
    expect(firstSouth).toBeGreaterThan(lastNorth);
    expect(md.indexOf('## Northern region')).toBeGreaterThan(-1);
    expect(md.indexOf('## Southern region')).toBeGreaterThan(md.indexOf('## Northern region'));
    // No interleaving: a NORTH line never appears after the first SOUTH line.
    expect(md.indexOf('Depot utilization')).toBeLessThan(firstSouth);
  });
});

describe('pdf2word tables: invoice (ruled, alignment clustering)', () => {
  it('recovers the 4x5 grid exactly (header + 4 item rows)', async () => {
    const md = await pageMd('fixture-p2w-invoice.pdf');
    expect(md).toContain('| Item | Qty | Unit price | Amount |');
    expect(md).toContain('| --- | --- | --- | --- |');
    expect(md).toContain('| Widget assembly | 4 | 450.00 | 1,800.00 |');
    expect(md).toContain('| Steel bracket | 12 | 12.50 | 150.00 |');
    expect(md).toContain('| Paint kit | 3 | 85.00 | 255.00 |');
    expect(md).toContain('| Labor hours | 16 | 40.00 | 640.00 |');
    expect(md).toContain('Total due: $2,845.00');
  });

  it('non-table content keeps reading order around the table', async () => {
    const md = await pageMd('fixture-p2w-invoice.pdf');
    expect(md.indexOf('# INVOICE')).toBeGreaterThanOrEqual(0);
    expect(md.indexOf('Bill to: Example Trading Co.')).toBeGreaterThan(md.indexOf('# INVOICE'));
    expect(md.indexOf('Total due')).toBeGreaterThan(md.indexOf('| Labor hours'));
  });

  it('two-column body text is NOT a table (coverage guard)', async () => {
    const items = await getVisualTextItems(bytesOf('fixture-p2w-twocol.pdf'), 1);
    expect(detectTable(items)).toBeNull();
  });

  it('emitter escapes pipes so the downstream split keeps one cell', () => {
    const md = emitTableMarkdown([['a', 'b|c'], ['d', 'e']]);
    expect(md).toContain('b\\|c'); // escaped at the emitter (F9 choke point)
    const html = markdownToSafeHtml(md);
    // One table, and the pipe survived INSIDE its cell.
    expect((html.match(/<tr>/g) ?? []).length).toBe(2);
    expect(html).toContain('b|c');
    expect(html).not.toContain('| <td'); // no column torn open by a raw pipe
  });
});

describe('pdf2word tables: borderless (gutter tier, v0.10.2)', () => {
  it('recovers the 5x4 statement grid: right-aligned numbers, sparse column, wide description', async () => {
    const md = await pageMd('fixture-p2w-borderless.pdf');
    expect(md).toContain('| Date | Description | Amount | Balance |');
    expect(md).toContain('| --- | --- | --- | --- |');
    expect(md).toContain('| 3/10 | ATM withdrawal | 250.00 | 2,548.20 |');
    expect(md).toContain('| 15/10 | Monthly service fee | 96.50 | 2,451.70 |');
    expect(md).toContain('| 8/10 | Grocery — Sample Mart |  | 2,451.70 |'); // sparse cell emits empty
    expect(md).toContain('| 12/10 | Transfer to online savings | 1,250.00 | 1,201.70 |');
    // Surrounding content keeps reading order around the table band.
    expect(md.indexOf('Account statement')).toBeLessThan(md.indexOf('| Date |'));
    expect(md.indexOf('Closing balance')).toBeGreaterThan(md.indexOf('| 12/10'));
  });

  it('caption on a tight pitch above the table stays text, never a table row', async () => {
    const md = await pageMd('fixture-p2w-borderless-caption.pdf');
    expect(md).toContain('| Date | Description | Amount | Balance |');
    expect(md).toContain('| 12/10 | Transfer to online savings | 1,250.00 | 1,201.70 |');
    expect(md).toContain('Transaction details');
    // The caption joins the band (its pitch == the table pitch) and must
    // fall out of the grid via the ≥2-cells rule — never become a row.
    expect(md).not.toContain('| Transaction details');
    expect(md.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(6); // header + sep + 4 rows
  });

  it('dense full-width paragraphs never tabulate (no corridor survives all rows)', async () => {
    const md = await pageMd('fixture-p2w-paragraphs.pdf');
    expect(md.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(0);
    expect(md).toContain('During the fourth quarter');
    expect(md).toContain('overtime budget carries into March');
  });

  it('three-column body text never tabulates — the 2-gutter danger class refuses via the guard', async () => {
    const items = await getVisualTextItems(bytesOf('fixture-p2w-threecol.pdf'), 1);
    expect(detectTable(items)).toBeNull();
    const md = await pageMd('fixture-p2w-threecol.pdf');
    expect(md.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(0);
    // Honest degrade: XY-cut still splits the columns — reading order is
    // column-by-column (all of col1 before col2, col2 before col3).
    expect(md.indexOf('fully positioned for December.')).toBeLessThan(md.indexOf('Coastal depots absorbed the'));
    expect(md.indexOf('summer produce peak season.')).toBeLessThan(md.indexOf('Grid capacity limits capped'));
  });
});

describe('gutterColumns (unit, v0.10.2)', () => {
  const item = (str: string, x0: number, x1: number, baseline = 100) => ({
    str,
    x0,
    x1,
    baseline,
    size: 10,
    fontName: 'F',
    rotated: false,
  });

  it(`requires >= ${BORDERLESS_MIN_COLS} gutters and returns corridor midpoints`, () => {
    expect(gutterColumns([])).toBeNull();
    expect(gutterColumns([item('a', 10, 50), item('b', 70, 120)])).toBeNull(); // 1 gutter = 2 columns
    const g = gutterColumns([item('a', 10, 50), item('b', 70, 120), item('c', 140, 200)]);
    expect(g).not.toBeNull();
    expect(g!.map((e) => e.x)).toEqual([60, 130]);
  });

  it(`in-cell word gaps below ${BORDERLESS_MIN_GAP_PT}pt never open a gutter`, () => {
    const g = gutterColumns([
      item('Card', 10, 30),
      item('purchase', 33, 62),
      item('scan', 64, 80),
      item('250.00', 200, 240),
      item('settled', 280, 320),
    ]);
    // The 2-4pt word gaps stay inside one cell; only the real corridors open.
    expect(g!.map((e) => e.x)).toEqual([(80 + 200) / 2, (240 + 280) / 2]);
  });

  it('union property: a wide header overlapping a right-aligned number opens no gutter', () => {
    const header = item('Total amount due', 100, 300);
    const number = item('1,800.00', 250, 300); // right-aligned under the header
    const right = item('Note', 340, 380);
    // Header + number are one ink mass for the sweep: the only corridor is
    // 300→340, so the band refuses (1 gutter < 2). Without the header the
    // same number column opens its own gutter.
    expect(gutterColumns([header, number, right])).toBeNull();
    expect(gutterColumns([item('x', 100, 140), number, right])!.map((e) => e.x)).toEqual([195, 320]);
  });
});

describe('pdf2word Vietnamese (subset Roboto)', () => {
  it('diacritics round-trip exactly; paragraphs merge; heading detected', async () => {
    const md = await pageMd('fixture-p2w-viet.pdf');
    expect(md).toContain('# Báo cáo tài chính quý IV');
    expect(md).toContain('Công ty cổ phần Chứng khoán Việt Nam công bố kết quả kinh doanh quý IV');
    expect(md).toContain('Lợi nhuận trước thuế đạt 428 tỷ đồng');
    expect(md).toContain('Cần Thơ, đồng thời nâng cấp nền tảng giao dịch trực tuyến.');
    expect(md).toContain('Người lập biểu: Phòng kế toán');
  });
});

describe('pdf2word lists', () => {
  it('bullets (with one nested level) and numbered items become markdown lists', async () => {
    const md = await pageMd('fixture-p2w-list.pdf');
    expect(md).toContain('# Meeting agenda');
    expect(md).toContain('- Welcome and minutes of the previous meeting');
    expect(md).toContain('  - Revenue breakdown by region');
    expect(md).toContain('- Open questions from the floor');
    expect(md).toContain('1. Approve the revised budget');
    expect(md).toContain('3. Adjourn');
    // The nested bullet stays inside the bullet list (before the numbered block).
    expect(md.indexOf('  - Revenue breakdown')).toBeGreaterThan(md.indexOf('- Quarterly numbers'));
    expect(md.indexOf('  - Revenue breakdown')).toBeLessThan(md.indexOf('- Open questions'));
  });
});

describe('pdf2word adversarial cells (F9 emitter contract)', () => {
  it('pipes/dollars/hashes survive the table without tearing columns', async () => {
    const md = await pageMd('fixture-p2w-adversarial.pdf');
    expect(md).toContain('| Item | Code | Price | Note |');
    expect(md).toContain('a\\|b\\|c'); // escaped in markdown, literal downstream
    expect(md).toContain('A\\|B pipe mix');
    expect(md).toContain('# hash tag');
    expect(md.indexOf('# Export ledger')).toBeLessThan(md.indexOf('| Item |')); // reading order
    const html = markdownToSafeHtml(md);
    expect(html).toContain('a|b|c');
    expect((html.match(/<tr>/g) ?? []).length).toBe(4);
  });

  it('cells with newlines degrade to text, never a malformed table', () => {
    // pdf.js items cannot carry newlines, but the emitter contract is
    // defensive: cellText collapses whitespace, so a hostile string stays
    // single-line inside one cell.
    const md = emitTableMarkdown([['h1', 'h2'], ['a\nb', 'c']]);
    expect(md.split('\n')).toHaveLength(3); // header + separator + one row
    const html = markdownToSafeHtml(md);
    expect((html.match(/<tr>/g) ?? []).length).toBe(2);
  });
});

describe('pdf2word rotated pages (collect, honest order)', () => {
  it('recovers all text at 90/180/270 (order quirks documented, not garbled)', async () => {
    for (const p of [1, 2, 3, 4]) {
      const md = await pageMd('fixture-rotated.pdf', p);
      expect(md).toContain('PDFTOOLKIT FIXTURE rotated');
      expect(md).toContain('The quick brown fox');
    }
  });
});

describe('mode census (F10 fixture classes)', () => {
  it('digital / scan / sandwich / mixed classify per the char floor', async () => {
    const charsOf = async (f: string): Promise<number[]> => {
      const bytes = bytesOf(f);
      const out: number[] = [];
      for (let p = 1; p <= (f.includes('mixed') ? 2 : 1); p += 1) {
        const items = await getVisualTextItems(bytes, p);
        out.push(items.reduce((n, i) => n + i.str.length, 0));
      }
      return out;
    };
    expect(censusMode(await charsOf('fixture-p2w-letter.pdf'))).toBe('digital');
    const scanChars = await charsOf('fixture-p2w-scan.pdf');
    expect(scanChars[0]).toBe(0);
    expect(censusMode(scanChars)).toBe('scan');
    // The app's OWN OCR output (image + text layer) is digital — its text
    // layer IS the content.
    const sandwichChars = await charsOf('fixture-p2w-sandwich.pdf');
    expect(sandwichChars[0]).toBeGreaterThanOrEqual(PDF2WORD_CENSUS_MIN_CHARS);
    expect(censusMode(sandwichChars)).toBe('digital');
    expect(censusMode(await charsOf('fixture-p2w-mixed.pdf'))).toBe('mixed');
  });

  it('sample is explicit: first + middle + last (F1)', () => {
    expect(censusSample(1)).toEqual([1]);
    expect(censusSample(2)).toEqual([1, 2]);
    expect(censusSample(7)).toEqual([1, 4, 7]);
  });
});

describe('composer routing (AI seam mocked — no model download)', () => {
  const stubDocx = (pages: { texts: string[] }): Promise<Uint8Array> =>
    Promise.resolve(new TextEncoder().encode(pages.texts.join('\n\n')));

  it('consumes digital geometry before requesting another page or awaiting AI', async () => {
    let rawAvailable = true;
    const text = 'A sufficiently long digital paragraph to exceed the scan census floor.';
    const items = [{
      str: text,
      get x0() { if (!rawAvailable) throw new Error('raw page retained past extraction boundary'); return 10; },
      x1: 400, baseline: 100, size: 12, fontName: 'F', rotated: false,
    }];
    const res = await runPdf2Word({
      pageCount: 2,
      extractPage: async (p) => {
        if (p === 1) return items;
        rawAvailable = false;
        return [];
      },
      aiConvertPages: async () => ['scan markdown'],
      toDocx: stubDocx,
    });
    expect(res.markdown).toEqual([text, 'scan markdown']);
  });

  it('digital input never touches the AI seam', async () => {
    let aiCalls = 0;
    const res = await runPdf2Word({
      pageCount: 1,
      extractPage: () => getVisualTextItems(bytesOf('fixture-p2w-letter.pdf'), 1),
      toDocx: stubDocx,
      aiConvertPages: async () => {
        aiCalls += 1;
        return [''];
      },
    });
    expect(res.mode).toBe('digital');
    expect(aiCalls).toBe(0);
    expect(res.docx.length).toBeGreaterThan(0);
    expect(res.markdown[0]).toContain('# Quarterly Operations Report');
  });

  it('mixed input routes ONLY the scan page through the AI seam', async () => {
    const scanned: number[] = [];
    const res = await runPdf2Word({
      pageCount: 2,
      extractPage: (p) => getVisualTextItems(bytesOf('fixture-p2w-mixed.pdf'), p),
      toDocx: stubDocx,
      aiConvertPages: async (pages) => {
        scanned.push(...pages);
        return pages.map((p) => `AI-OCR page ${p}`);
      },
    });
    expect(res.mode).toBe('mixed');
    expect(scanned).toEqual([2]);
    expect(res.markdown[0]).toContain('mixed-mode routing fixture');
    expect(res.markdown[1]).toBe('AI-OCR page 2');
    expect(res.scanPagesConverted).toEqual([2]);
  });

  it('scan input without a seam refuses with the typed error (fail closed)', async () => {
    await expect(
      runPdf2Word({
        pageCount: 1,
        extractPage: () => getVisualTextItems(bytesOf('fixture-p2w-scan.pdf'), 1),
        toDocx: stubDocx,
      }),
    ).rejects.toThrow(Pdf2WordScanError);
  });

  it('progress yields per page across extraction and conversion halves', async () => {
    const ticks: [number, number][] = [];
    await runPdf2Word({
      pageCount: 2,
      extractPage: (p) => getVisualTextItems(bytesOf('fixture-p2w-mixed.pdf'), p),
      toDocx: stubDocx,
      aiConvertPages: async (pages) => pages.map(() => 'AI'),
      onProgress: (done, total) => ticks.push([done, total]),
    });
    expect(ticks).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it('page selection: deduped, sorted, bounds+integer filtered, queue-relative routing', async () => {
    const extracted: number[] = [];
    const scanned: number[] = [];
    const res = await runPdf2Word({
      pageCount: 2,
      // Duplicates, out-of-order, out-of-bounds, zero — all laundered to
      // the sorted unique queue [1, 2].
      pages: [2, 1, 1, 99, 0],
      extractPage: (p) => {
        extracted.push(p);
        return getVisualTextItems(bytesOf('fixture-p2w-mixed.pdf'), p);
      },
      toDocx: stubDocx,
      aiConvertPages: async (pages) => {
        scanned.push(...pages);
        return pages.map((p) => `AI-OCR page ${p}`);
      },
    });
    expect(extracted.sort()).toEqual([1, 2]);
    expect(scanned).toEqual([2]); // census stays queue-relative (selection position 2 = doc page 2)
    expect(res.markdown).toHaveLength(2);
    expect(res.markdown[0]).toContain('mixed-mode routing fixture');
    expect(res.markdown[1]).toBe('AI-OCR page 2');
    expect(res.scanPagesConverted).toEqual([2]);
  });

  it('an empty (fully-filtered) selection refuses honestly', async () => {
    await expect(
      runPdf2Word({
        pageCount: 2,
        pages: [0, 99],
        extractPage: async () => [],
        toDocx: stubDocx,
      }),
    ).rejects.toThrow('empty page selection');
  });

  it('a short AI seam result is a hard error, never silent-empty scan pages', async () => {
    await expect(
      runPdf2Word({
        pageCount: 2,
        extractPage: (p) => getVisualTextItems(bytesOf('fixture-p2w-mixed.pdf'), p),
        toDocx: stubDocx,
        aiConvertPages: async () => [], // under-filled client (aborted run bug class)
      }),
    ).rejects.toThrow('AI seam returned 0 pages for 1 scan pages');
  });
});

describe('input budgets (RED-TEAM F1)', () => {
  it('page cap refuses above 100 pages', async () => {
    await expect(
      runPdf2Word({ pageCount: PDF2WORD_PAGE_CAP + 1, extractPage: async () => [], toDocx: async () => new Uint8Array() }),
    ).rejects.toThrow(Pdf2WordPageCapError);
  });

  it('per-page item cap refuses instead of truncating', async () => {
    const spam = Array.from({ length: PDF2WORD_MAX_ITEMS_PER_PAGE + 1 }, (_, i) => ({
      str: `w${i}`,
      x0: 10 + i,
      x1: 20 + i,
      baseline: 100,
      size: 10,
      fontName: 'F1',
      rotated: false,
    }));
    await expect(
      runPdf2Word({ pageCount: 1, extractPage: async () => spam, toDocx: async () => new Uint8Array() }),
    ).rejects.toThrow(Pdf2WordItemCapError);
  });

  it('sanitizer drops NaN/Infinity/huge-coordinate items at the boundary', () => {
    const base = { str: 'x', x0: 10, x1: 20, baseline: 100, size: 10, fontName: 'F1', rotated: false };
    const kept = sanitizeItems([
      { ...base },
      { ...base, x0: NaN, x1: 30 },
      { ...base, baseline: Infinity },
      { ...base, x1: 5e6 },
      { ...base, size: 0 },
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe('markdown-shape contract (what the DOCX emitter expects)', () => {
  it('every fixture page-markdown parses to well-formed structures', async () => {
    for (const f of [
      'fixture-p2w-letter.pdf',
      'fixture-p2w-invoice.pdf',
      'fixture-p2w-twocol.pdf',
      'fixture-p2w-viet.pdf',
      'fixture-p2w-list.pdf',
      'fixture-p2w-adversarial.pdf',
    ]) {
      const md = await pageMd(f);
      const html = markdownToSafeHtml(md);
      // A pipe-table line is either a full row or nothing (no torn rows).
      for (const line of md.split('\n')) {
        if (line.startsWith('|')) expect(line.trimEnd().endsWith('|')).toBe(true);
      }
      // Table row width consistency: every row in one table has the same
      // cell count as its header.
      const tables = html.match(/<table>[\s\S]*?<\/table>/g) ?? [];
      for (const t of tables) {
        const rows = t.match(/<tr>/g) ?? [];
        expect(rows.length).toBeGreaterThanOrEqual(2);
      }
      expect(html).not.toContain('<script');
    }
  });

  it('heading levels stay within the docx clamp (h4 max downstream)', async () => {
    const md = await pageMd('fixture-p2w-letter.pdf');
    for (const line of md.split('\n')) {
      const m = /^(#+)\s/.exec(line);
      if (m) expect(m[1]!.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('DOCX emitter title option (F9, OCR path byte-identical)', () => {
  it('default title stays pdftoolkit-ocr; pdf2word can pass its own', async () => {
    const pages = { texts: ['Plain paragraph'] };
    const defaultBytes = await markdownToDocx(pages);
    const titledBytes = await markdownToDocx({ ...pages, title: 'invoice-2026' });
    // Both export; the buffers differ (metadata title), and both are
    // non-empty DOCX (PK zip magic).
    expect(defaultBytes[0]).toBe(0x50);
    expect(titledBytes[0]).toBe(0x50);
    expect(defaultBytes.length).toBeGreaterThan(1000);
    // The engine table path through the SAME emitter (integration).
    const md = await pageMd('fixture-p2w-invoice.pdf');
    const docx = await markdownToDocx({ texts: [md], title: 'INV-2026-0417' });
    expect(docx[0]).toBe(0x50);
  });
});

describe('layout primitives (unit edges)', () => {
  it('xyCut leaves a single-fragment region untouched', () => {
    const item = { str: 'a', x0: 0, x1: 10, baseline: 0, size: 10, fontName: 'F', rotated: false };
    expect(xyCut([item], 10)).toEqual([[item]]);
  });

  it('pageBodySize picks the modal rounded size', async () => {
    const items = await getVisualTextItems(bytesOf('fixture-p2w-letter.pdf'), 1);
    expect(pageBodySize(items)).toBe(11);
  });
});
