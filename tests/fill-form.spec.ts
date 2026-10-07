import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
import {
  fillFormFields,
  fillTextFields,
  inspectFormFields,
  inspectFormFieldsAll,
} from '../src/engine/pdf-lib';

/*
 * AcroForm fill core (phase 6a) + every field type / flatten / signed / XFA
 * (phase 6b). Runs the engine module directly in Node: pdf-lib +
 * @pdf-lib/fontkit are pure JS, so the fill pipeline (subset embed + setText
 * + per-field appearance updates + flatten) is exercised byte-for-byte as
 * shipped. Fixtures come from tests/fixtures/gen.mjs; the suite self-skips
 * when a fixture or the committed Roboto TTF is missing (same pattern as
 * cert specs).
 */
const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const ROBOTO = join(import.meta.dirname, '..', 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const hasFixtures = [
  'form-vn.pdf',
  'form-vn-full.pdf',
  'form-vn-signed.pdf',
  'form-xfa.pdf',
  'fixture-locked.pdf',
].every((f) => {
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
const fullBytes = () => new Uint8Array(readFileSync(fx('form-vn-full.pdf')));
const signedBytes = () => new Uint8Array(readFileSync(fx('form-vn-signed.pdf')));

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

// ---- phase 6b: every field type, flatten, signed, XFA ----------------------

d('inspectFormFieldsAll', () => {
  it('catalogs every field type of the full VN fixture with labels and options', async () => {
    const result = await inspectFormFieldsAll(fullBytes());
    expect(result.hasXFA).toBe(false);
    expect(result.hasSignature).toBe(false);
    expect(result.totalFields).toBe(8);
    const byName = new Map(result.fields.map((f) => [f.name, f]));
    expect(byName.get('ho_ten')).toMatchObject({
      name: 'ho_ten',
      label: 'Họ và tên',
      page: 1,
      type: 'text',
      multiline: false,
      readOnly: false,
      value: '',
    });
    expect(byName.get('dia_chi')).toMatchObject({ type: 'text', multiline: true, label: 'Địa chỉ' });
    expect(byName.get('ghi_chu')).toMatchObject({ type: 'text', multiline: true, label: 'Ghi chú' });
    expect(byName.get('ma_ho_so')).toMatchObject({
      type: 'text',
      readOnly: true,
      value: 'FT-2026-VN',
      label: 'Mã hồ sơ',
    });
    expect(byName.get('dong_y')).toMatchObject({ type: 'checkbox', checked: false, label: 'Đồng ý điều khoản' });
    expect(byName.get('gioi_tinh')).toMatchObject({ type: 'radio', options: ['nam', 'nu'], value: '' });
    // >4 options — the UI renders this group as a dropdown-style select.
    expect(byName.get('khu_vuc')).toMatchObject({
      type: 'radio',
      options: ['mb', 'mt', 'mn', 'tb', 'tn'],
    });
    expect(byName.get('nghe')).toMatchObject({
      type: 'dropdown',
      options: ['Kế toán', 'Kỹ sư', 'Bác sĩ', 'Khác'],
      selected: [],
      editable: false,
    });
  });

  it('flags the /FT /Sig fixture via hasSignature without dropping the other fields', async () => {
    const result = await inspectFormFieldsAll(signedBytes());
    expect(result.hasSignature).toBe(true);
    expect(result.totalFields).toBe(9);
    // The sig field itself is listed (the UI renders it as a read-only row).
    expect(result.fields.filter((f) => f.type === 'signature').map((f) => f.name)).toEqual(['Sig1']);
  });

  it('refuses the XFA fixture before any form access', async () => {
    const result = await inspectFormFieldsAll(new Uint8Array(readFileSync(fx('form-xfa.pdf'))));
    expect(result).toEqual({ hasXFA: true, totalFields: 0, hasSignature: false, fields: [] });
  });
});

d('fillFormFields', () => {
  it('fills text, checkbox, both radios and dropdown; nothing skipped; values persist', async () => {
    const out = await fillFormFields(
      fullBytes(),
      {
        texts: {
          ho_ten: 'Nguyễn Văn Ánh',
          dia_chi: '48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng',
          ghi_chu: 'Có dấu: Đà Lạt.',
        },
        checkboxes: { dong_y: true },
        radios: { gioi_tinh: 'nu', khu_vuc: 'mn' },
        choices: { nghe: 'Kỹ sư' },
      },
      robotoBytes(),
    );
    expect(out.skipped).toEqual([]);
    const doc = await PDFDocument.load(out.bytes);
    const form = doc.getForm();
    expect((form.getTextField('ho_ten')).getText()).toBe('Nguyễn Văn Ánh');
    expect((form.getTextField('dia_chi')).getText()).toBe('48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng');
    expect(form.getCheckBox('dong_y').isChecked()).toBe(true);
    expect(form.getRadioGroup('gioi_tinh').getSelected()).toBe('nu');
    expect(form.getRadioGroup('khu_vuc').getSelected()).toBe('mn');
    expect(form.getDropdown('nghe').getSelected()).toEqual(['Kỹ sư']);
    // Readonly stays untouched even when a value was (wrongly) sent for it.
    expect((form.getTextField('ma_ho_so')).getText()).toBe('FT-2026-VN');
  });

  it('unchecks a checked checkbox and clears a dropdown selection', async () => {
    // Author a checked box + preselected dropdown, then clear both.
    const src = await PDFDocument.load(fullBytes());
    const form = src.getForm();
    form.getCheckBox('dong_y').check();
    form.getDropdown('nghe').select('Bác sĩ');
    const pre = await src.save({ updateFieldAppearances: false });
    const out = await fillFormFields(
      new Uint8Array(pre),
      { checkboxes: { dong_y: false }, choices: { nghe: '' } },
      robotoBytes(),
    );
    expect(out.skipped).toEqual([]);
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getForm().getCheckBox('dong_y').isChecked()).toBe(false);
    expect(doc.getForm().getDropdown('nghe').getSelected()).toEqual([]);
  });

  it('tames the AUTO multiline blowup: explicit fitting size, no 62pt text (#1581)', async () => {
    const text = 'Ghi chú có dấu: Đà Lạt, năm 2026. Dòng thứ hai khá dài để buộc wrap khi hiển thị.';
    const out = await fillFormFields(fullBytes(), { texts: { ghi_chu: text } }, robotoBytes());
    const doc = await PDFDocument.load(out.bytes);
    const field = doc.getForm().getTextField('ghi_chu');
    // /DA mutated to an explicit size (the chosen mitigation) — never AUTO/0.
    expect(field.acroField.getDefaultAppearance()).toMatch(/\/[\w-]+ ([\d.]+) Tf/);
    const ap = widgetDictOf(field).lookup(PDFName.of('AP'), PDFDict);
    const lines = parseAppearance(decodePDFRawStream(ap.lookup(PDFName.of('N')) as PDFRawStream).decode());
    console.log('[fill-form] AUTO multiline mitigation evidence:', JSON.stringify(lines));
    expect(lines.sizes.length).toBeGreaterThan(0);
    for (const size of lines.sizes) {
      expect(size).toBeLessThanOrEqual(12); // downward search starts at 12
      expect(size).toBeGreaterThanOrEqual(4); // overflow floor
    }
    const [y1, y2] = lines.baselineYs;
    expect(y1).toBeGreaterThan(y2); // line order preserved
    expect(y1).toBeLessThanOrEqual(72); // inside the 72pt widget box
    expect(y2).toBeGreaterThanOrEqual(0);
  });

  it('does not regress explicit-size multiline (dia_chi stays 12pt, lines in box)', async () => {
    const out = await fillFormFields(
      fullBytes(),
      { texts: { dia_chi: '48 Nguyễn Trãi, Hà Nội\nQuận Hai Bà Trưng' } },
      robotoBytes(),
    );
    const doc = await PDFDocument.load(out.bytes);
    const field = doc.getForm().getTextField('dia_chi');
    const ap = widgetDictOf(field).lookup(PDFName.of('AP'), PDFDict);
    const lines = parseAppearance(decodePDFRawStream(ap.lookup(PDFName.of('N')) as PDFRawStream).decode());
    expect(lines.sizes).toEqual([12]);
  });

  it('quarantines a broken widget: one field skipped, the rest still saved', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const page = doc.addPage([300, 120]);
    const form = doc.getForm();
    const bad = form.createTextField('bad_widget');
    bad.addToPage(page, { x: 10, y: 60, width: 120, height: 22 });
    const kids = bad.acroField.dict.lookup(PDFName.of('Kids'), PDFArray);
    kids.lookup(0, PDFDict).delete(PDFName.of('Rect')); // hostile widget — appearance gen throws
    const good = form.createTextField('good');
    good.addToPage(page, { x: 10, y: 20, width: 120, height: 22 });
    const pre = await doc.save({ updateFieldAppearances: false });
    const out = await fillFormFields(
      new Uint8Array(pre),
      { texts: { bad_widget: 'gãy', good: 'sống' } },
      robotoBytes(),
    );
    expect(out.skipped).toEqual(['bad_widget']);
    const outDoc = await PDFDocument.load(out.bytes);
    expect((outDoc.getForm().getField('good') as PDFTextField).getText()).toBe('sống');
  });

  it('flatten bakes fields away: zero fields, zero annots, VN glyphs render', async () => {
    const out = await fillFormFields(
      fullBytes(),
      {
        texts: { ho_ten: 'Nguyễn Văn Ánh', dia_chi: '48 Nguyễn Trãi, Hà Nội' },
        checkboxes: { dong_y: true },
        radios: { gioi_tinh: 'nam' },
        choices: { nghe: 'Kế toán' },
      },
      robotoBytes(),
      { flatten: true },
    );
    expect(out.skipped).toEqual([]);
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);

    // Render verify (pdf.js + napi canvas): the baked page must show the VN
    // text as pixels, and text extraction must return the exact diacritics.
    const pageText = await extractPageText(out.bytes, 1);
    expect(pageText).toContain('Nguyễn Văn Ánh');
    expect(pageText).toContain('48 Nguyễn Trãi, Hà Nội');
    // Interior of the ho_ten widget (4pt inset skips the baked border box).
    const dark = await darkPixelCount(out.bytes, { x: 144, y: 790, w: 232, h: 16 });
    console.log('[fill-form] flatten glyph evidence: dark px in ho_ten interior =', dark);
    expect(dark).toBeGreaterThan(200);
  });

  it('flatten leaves an empty form blank in the ho_ten interior (text came from the fill)', async () => {
    const out = await fillFormFields(fullBytes(), {}, robotoBytes(), { flatten: true });
    const dark = await darkPixelCount(out.bytes, { x: 144, y: 790, w: 232, h: 16 });
    expect(dark).toBeLessThan(20);
  });

  it('flatten never bakes or removes signature fields (R15)', async () => {
    const out = await fillFormFields(
      signedBytes(),
      { texts: { ho_ten: 'Điền trên file đã ký' } },
      robotoBytes(),
      { flatten: true },
    );
    expect(out.skipped).toEqual([]);
    const doc = await PDFDocument.load(out.bytes);
    const names = doc.getForm().getFields().map((f) => f.getName());
    expect(names).toEqual(['Sig1']); // sig field survives as a field
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0); // every widget baked away
  });

  it('refuses encrypted input with the message the UI routes to decrypt', async () => {
    const locked = new Uint8Array(readFileSync(fx('fixture-locked.pdf')));
    await expect(
      fillFormFields(locked, { texts: { x: '1' } }, robotoBytes()),
    ).rejects.toThrow(/encrypted/i);
  });
});

// ---- node-side render helpers (same pattern as tests/ocr-integration.spec.ts)

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

interface PdfRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Renders page 1 and counts dark pixels inside a PDF-point region (y-up). */
async function darkPixelCount(bytes: Uint8Array, region: PdfRegion): Promise<number> {
  const [{ createCanvas }, legacy] = await Promise.all([
    import('@napi-rs/canvas'),
    pdfjsLegacy(),
  ]);
  const task = legacy.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = 2;
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    const x0 = Math.floor(region.x * scale);
    const y0 = Math.floor((base.height - (region.y + region.h)) * scale);
    const w = Math.ceil(region.w * scale);
    const h = Math.ceil(region.h * scale);
    const img = ctx.getImageData(x0, y0, w, h);
    let dark = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      if (lum < 140) dark += 1;
    }
    return dark;
  } finally {
    await task.destroy();
  }
}
