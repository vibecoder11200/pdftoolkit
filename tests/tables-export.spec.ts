import { describe, expect, it } from 'vitest';

import { emitCsv, CSV_DEFAULTS } from '../src/lib/tables/csv';
import { buildXlsx, type XlsxSheetInput } from '../src/lib/tables/xlsx';
import { markdownTableRows } from '../src/lib/tables/scan';

const DECODER = new TextDecoder();

describe('csv emitter — safety + fidelity', () => {
  const rows = [
    ['ID', 'Name', 'Note'],
    ['00123', '=cmd|/c calc!A1', 'line1\nline2'],
  ];

  it('safe default: formula prefixes neutralized + counted', () => {
    const r = emitCsv(rows);
    const text = DECODER.decode(r.bytes).replace(/^\uFEFF/, '');
    expect(text.split('\r\n')[1]).toBe('"00123","\'=cmd|/c calc!A1","line1\nline2"');
    expect(r.transformedCells).toBe(1);
    expect(r.transformedExamples[0]).toBe('=cmd|/c calc!A1');
  });

  it('raw mode is never the default (CSV_DEFAULTS are safe)', () => {
    expect(CSV_DEFAULTS.safe).toBe(true);
    expect(CSV_DEFAULTS.bom).toBe(true);
    expect(CSV_DEFAULTS.quoteAll).toBe(true);
    expect(CSV_DEFAULTS.delimiter).toBe(',');
  });

  it('quotes/newlines/delimiters escape per RFC-4180 shape (CR stripped by safe mode)', () => {
    const r = emitCsv([['a"b', 'x;y', 'p\r\nq']], { delimiter: ';' });
    const text = DECODER.decode(r.bytes).replace(/^\uFEFF/, '');
    expect(text).toBe('"a""b";"x;y";"p\nq"');
    // raw mode keeps the CR byte-honest (explicit caller decision)
    const raw = emitCsv([['p\r\nq']], { safe: false });
    expect(DECODER.decode(raw.bytes)).toBe('"p\r\nq"');
    // the CR-strip IS a transformation — counted
    expect(r.transformedCells).toBe(1);
  });

  it('full-width prefixes neutralized + counted', () => {
    const r = emitCsv([['＝sum', 'A', 'B'], ['x', 'y', 'z']], { bom: false });
    const text = DECODER.decode(r.bytes);
    expect(text.split('\r\n')[0]).toContain("'＝sum");
    expect(r.transformedCells).toBe(1);
  });

  it('BOM off honored; tab delimiter honored', () => {
    const r = emitCsv([['a', 'b']], { bom: false, delimiter: '\t' });
    expect(DECODER.decode(r.bytes)).toBe('"a"\t"b"');
  });
});

describe('scan markdown parse', () => {
  it('markdownTableRows: escaped pipes, separator skipped', () => {
    const rows = markdownTableRows('| A | B |\n| --- | --- |\n| x \\| y | z |');
    expect(rows).toEqual([['A', 'B'], ['x | y', 'z']]);
  });

  it('no table -> null (honest refusal)', () => {
    expect(markdownTableRows('no table here')).toBeNull();
  });
});

describe('xlsx builder — data-only workbook', () => {
  it('text exact; zero formulas; zero external relationships', async () => {
    const input: XlsxSheetInput = { name: 'Main', rows: [['ID', 'Qty'], ['00123', '0123.5'], ['42', '']] };
    const { bytes } = await buildXlsx([input]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheetXml).not.toContain('<f>');
    const shared = await zip.file('xl/sharedStrings.xml')!.async('string');
    expect(shared).toContain('00123');
    const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
    expect(rels).not.toContain('TargetMode="External"');
  }, 30000);

  it('number column parses; leading-zero ID stays exact text', async () => {
    const input: XlsxSheetInput = {
      name: 'Numbers',
      rows: [['ID', 'Qty'], ['00123', '12.5'], ['099', '0.5']],
      colKinds: ['text', 'number'],
    };
    const { bytes, parsedCells } = await buildXlsx([input]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const shared = await zip.file('xl/sharedStrings.xml')!.async('string');
    expect(shared).toContain('00123');
    expect(shared).toContain('099');
    expect(parsedCells).toBe(2);
  }, 30000);

  it('precision >15 digits falls back to exact string + is reported', async () => {
    const input: XlsxSheetInput = {
      name: 'Prec',
      rows: [['v'], ['12345678901234567890']],
      colKinds: ['number'],
    };
    const { bytes, precisionFallbacks } = await buildXlsx([input]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const shared = await zip.file('xl/sharedStrings.xml')!.async('string');
    expect(shared).toContain('12345678901234567890');
    expect(precisionFallbacks).toContain('12345678901234567890');
  }, 30000);

  it('ISO dates parse only in date columns; ambiguous forms stay text', async () => {
    const input: XlsxSheetInput = {
      name: 'Dates',
      rows: [['d1', 'd2'], ['2026-01-02', '03/04/2026']],
      colKinds: ['date', 'date'],
    };
    const { bytes, parsedCells } = await buildXlsx([input]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    // OOXML stores a parsed date as a numeric serial in a date-numFmt style
    expect(sheetXml).toMatch(/<c r="A2"[^>]*><v>\d+<\/v><\/c>/);
    const shared = await zip.file('xl/sharedStrings.xml')!.async('string');
    expect(shared).not.toContain('2026-01-02');
    expect(shared).toContain('03/04/2026');
    expect(parsedCells).toBe(1);
  }, 30000);
});

describe('scan sheet model — unverified cells', () => {
  it('sheetFromScanMarkdown: review warnings + provenance + confidence null', async () => {
    const { sheetFromScanMarkdown } = await import('../src/lib/tables/scan');
    const sheet = sheetFromScanMarkdown(
      '| A | B |\n| --- | --- |\n| x | 12 |',
      4,
    );
    expect(sheet.provenance.scan).toBe(true);
    expect(sheet.provenance.sourcePages).toEqual([4]);
    for (const c of sheet.cells) {
      expect(c.warnings).toContain('review');
      expect(c.confidence).toBeNull();
      expect(c.sourcePage).toBe(4);
    }
  });
});
