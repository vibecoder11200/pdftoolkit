import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFTextField,
  decodePDFRawStream,
} from 'pdf-lib';
import * as fontkit from '@pdf-lib/fontkit';
import { fillTextFields, inspectFormFields } from '../src/engine/pdf-lib';

/*
 * AcroForm fill core (phase 6a). Runs the engine module directly in Node:
 * pdf-lib + @pdf-lib/fontkit are pure JS, so the fill pipeline (subset embed
 * + setText + updateFieldAppearances) is exercised byte-for-byte as shipped.
 * Fixtures come from tests/fixtures/gen.mjs; the suite self-skips when the
 * fixture or the committed Roboto TTF is missing (same pattern as cert specs).
 */
const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const ROBOTO = join(import.meta.dirname, '..', 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const hasFixtures = ['form-vn.pdf', 'fixture-locked.pdf'].every((f) => {
  try {
    readFileSync(fx(f));
    return true;
  } catch {
    return false;
  }
}) && (() => {
  try {
    readFileSync(ROBOTO);
    return true;
  } catch {
    return false;
  }
})();
const d = hasFixtures ? describe : describe.skip;
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

/** The widget holding /AP: split fields keep it under /Kids[0]. */
function widgetDictOf(field: PDFTextField): PDFDict {
  const kids = field.acroField.dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  return kids && kids.size() > 0 ? kids.lookup(0, PDFDict) : field.acroField.dict;
}

interface AppearanceLines {
  sizes: number[];
  baselineYs: number[];
  tjCount: number;
}

/**
 * Extracts font sizes and per-line baselines from a /Tx appearance stream.
 * pdf-lib emits one `1 0 0 1 x y Tm` per line (Td never appears in its
 * output, but is parsed as a fallback for foreign producers).
 */
function parseAppearance(stream: Uint8Array): AppearanceLines {
  const text = Buffer.from(stream).toString('latin1');
  const sizes = [...text.matchAll(/([\d.]+)\s+Tf/g)].map((m) => Number(m[1]));
  const baselineYs: number[] = [];
  for (const m of text.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)) baselineYs.push(Number(m[2]));
  if (baselineYs.length === 0) {
    for (const m of text.matchAll(/(?:^|\s)(-?[\d.]+)\s+(-?[\d.]+)\s+Td/g)) {
      baselineYs.push(Number(m[2]));
    }
  }
  const tjCount = (text.match(/Tj/g) ?? []).length;
  return { sizes, baselineYs, tjCount };
}

d('inspectFormFields', () => {
  it('detects the VN fixture fields with labels, pages, and flags', async () => {
    const result = await inspectFormFields(new Uint8Array(readFileSync(fx('form-vn.pdf'))));
    expect(result.hasXFA).toBe(false);
    expect(result.totalFields).toBe(2);
    expect(result.textFields).toEqual([
      {
        name: 'ho_ten',
        label: 'Họ và tên',
        page: 1,
        required: false,
        readOnly: false,
        multiline: false,
        value: '',
      },
      {
        name: 'dia_chi',
        label: 'Địa chỉ',
        page: 1,
        required: false,
        readOnly: false,
        multiline: true,
        value: '',
      },
    ]);
  });

  it('flags XFA via the catalog /AcroForm /XFA key', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 100]);
    const field = doc.getForm().createTextField('x');
    field.addToPage(page, { x: 10, y: 10, width: 80, height: 20 });
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    acro.set(PDFName.of('XFA'), PDFHexString.fromText('<xdp/>'));
    // pdf-lib's save() silently strips /XFA, so serialize the mutated context
    // directly. PDFStreamWriter is runtime-only (absent from pdf-lib d.ts) —
    // narrow structural cast instead of `any`.
    type ContextWriter = {
      forContext(
        context: typeof doc.context,
        objectsPerTick: number,
      ): { serializeToBuffer(): Promise<Uint8Array> };
    };
    const { PDFStreamWriter } = (await import('pdf-lib')) as typeof import('pdf-lib') & {
      PDFStreamWriter: ContextWriter;
    };
    const bytes = await PDFStreamWriter.forContext(doc.context, 50).serializeToBuffer();
    const result = await inspectFormFields(bytes);
    expect(result.hasXFA).toBe(true);
  });

  it('reports a PDF without /AcroForm as zero fields, no XFA', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]);
    const result = await inspectFormFields(await doc.save());
    expect(result).toEqual({ hasXFA: false, totalFields: 0, textFields: [] });
  });

  it('refuses encrypted input with the message the UI routes to decrypt', async () => {
    const locked = new Uint8Array(readFileSync(fx('fixture-locked.pdf')));
    await expect(inspectFormFields(locked)).rejects.toThrow(/encrypted/i);
    await expect(fillTextFields(locked, { x: '1' }, robotoBytes())).rejects.toThrow(/encrypted/i);
  });
});

d('fillTextFields', () => {
  it('fills VN single-line + multiline, save → reload returns exact strings', async () => {
    const saved = await fillTextFields(
      new Uint8Array(readFileSync(fx('form-vn.pdf'))),
      {
        ho_ten: 'Nguyễn Văn Ánh',
        dia_chi: '48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng',
      },
      robotoBytes(),
    );
    const out = await PDFDocument.load(saved);
    const form = out.getForm();
    expect((form.getField('ho_ten') as PDFTextField).getText()).toBe('Nguyễn Văn Ánh');
    expect((form.getField('dia_chi') as PDFTextField).getText()).toBe(
      '48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng',
    );
    // The inspect path (UI field list) reads the persisted values back too.
    const result = await inspectFormFields(saved);
    expect(result.textFields.map((f) => f.value)).toEqual([
      'Nguyễn Văn Ánh',
      '48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng',
    ]);
  });

  it('embeds a font subset in the saved bytes (/FontFile2 stream present)', async () => {
    const original = readFileSync(fx('form-vn.pdf'));
    const saved = await fillTextFields(
      new Uint8Array(original),
      { ho_ten: 'Ánh' },
      robotoBytes(),
    );
    // useObjectStreams:false keeps dict keys literal, so a byte scan is sound.
    expect(Buffer.from(saved).includes('/FontFile2')).toBe(true);
    expect(saved.byteLength).toBeGreaterThan(original.byteLength);
  });

  it('multiline appearance keeps two lines inside the box (#1581 check)', async () => {
    const saved = await fillTextFields(
      new Uint8Array(readFileSync(fx('form-vn.pdf'))),
      { dia_chi: '48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng' },
      robotoBytes(),
    );
    const out = await PDFDocument.load(saved);
    const field = out.getForm().getField('dia_chi') as PDFTextField;
    const ap = widgetDictOf(field).lookup(PDFName.of('AP'), PDFDict);
    const lines = parseAppearance(decodePDFRawStream(ap.lookup(PDFName.of('N')) as PDFRawStream).decode());
    // Evidence for the cantoo-decision journal (plan phase 6a).
    console.log('[fill-form] multiline #1581 evidence:', JSON.stringify(lines));
    expect(lines.tjCount).toBe(2); // one Tj run per \n line — breaks preserved
    expect(lines.sizes).toHaveLength(1); // one explicit size, no auto-size blowup
    const [size] = lines.sizes;
    const [y1, y2] = lines.baselineYs;
    expect(y1).toBeGreaterThan(y2); // line 1 above line 2 (PDF y grows upward)
    // #1581 line-height guard: baselines must not overlap and must stay in
    // the 72pt widget box. Broken builds spill baselines below 0.
    expect(y1).toBeLessThanOrEqual(72);
    expect(y2).toBeGreaterThanOrEqual(0);
    expect(y1 - y2).toBeGreaterThanOrEqual(size);
  });

  it('skips readonly fields and unknown names', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const page = doc.addPage([300, 120]);
    const form = doc.getForm();
    const ro = form.createTextField('ro');
    ro.addToPage(page, { x: 10, y: 60, width: 120, height: 22 });
    ro.setText('giữ nguyên');
    ro.enableReadOnly();
    const rw = form.createTextField('rw');
    rw.addToPage(page, { x: 10, y: 20, width: 120, height: 22 });
    // updateFieldAppearances:false mirrors what fillTextFields does at save —
    // pdf-lib's save() default pass would regenerate the dirty `ro` field with
    // WinAnsi Helvetica and throw on "ữ" before the engine is even reached.
    const saved = await fillTextFields(
      await doc.save({ updateFieldAppearances: false }),
      { ro: 'bị ghi đè', rw: 'đã điền', khong_ton_tai: 'bỏ qua' },
      robotoBytes(),
    );
    const out = await PDFDocument.load(saved);
    expect((out.getForm().getField('ro') as PDFTextField).getText()).toBe('giữ nguyên');
    expect((out.getForm().getField('rw') as PDFTextField).getText()).toBe('đã điền');
  });

  it('keeps fields interactive after fill (no flattening)', async () => {
    const saved = await fillTextFields(
      new Uint8Array(readFileSync(fx('form-vn.pdf'))),
      { ho_ten: 'Test' },
      robotoBytes(),
    );
    const out = await PDFDocument.load(saved);
    // Widget annotations still exist on the page — AcroForm not flattened.
    const annots = out.getPage(0).node.Annots();
    expect(annots?.size()).toBe(2);
    expect(out.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)).toBeDefined();
  });
});
