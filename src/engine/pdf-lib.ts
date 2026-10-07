import { PDFDocument } from 'pdf-lib';

export interface PageInfo {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PdfInfo {
  numPages: number;
  pageInfos: PageInfo[];
  fingerprint: string;
  fileSizeBytes: number;
}

function fingerprint(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const n = Math.min(bytes.length, 65536);
  for (let i = 0; i < n; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619);
    h2 = Math.imul(h2 + bytes[i], 31);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

export async function loadPdf(bytes: Uint8Array): Promise<{ info: PdfInfo }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageInfos: PageInfo[] = doc.getPages().map((page, i) => ({
    pageNumber: i + 1,
    width: page.getWidth(),
    height: page.getHeight(),
    rotation: page.getRotation().angle,
  }));
  return {
    info: {
      numPages: doc.getPageCount(),
      pageInfos,
      fingerprint: fingerprint(bytes),
      fileSizeBytes: bytes.byteLength,
    },
  };
}

export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part, { ignoreEncryption: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return out.save({ useObjectStreams: false });
}

export async function mergeSelected(parts: Uint8Array[], picks: number[][]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < parts.length; i += 1) {
    const sel = picks[i] ?? [];
    if (sel.length === 0) continue;
    const src = await PDFDocument.load(parts[i], { ignoreEncryption: false });
    const pages = await out.copyPages(src, sel.map((n) => n - 1));
    for (const p of pages) out.addPage(p);
  }
  return out.save({ useObjectStreams: false });
}

export async function removePages(bytes: Uint8Array, pagesToRemove: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const indices = [...new Set(pagesToRemove.map((n) => n - 1))]
    .filter((i) => i >= 0 && i < doc.getPageCount())
    .sort((a, b) => b - a);
  for (const i of indices) doc.removePage(i);
  return doc.save({ useObjectStreams: false });
}

export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const count = src.getPageCount();
  if (order.length !== count) throw new Error(`reorder: order length ${order.length} != ${count}`);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, order.map((n) => n - 1));
  for (const p of pages) out.addPage(p);
  return out.save({ useObjectStreams: false });
}

export async function rotatePages(
  bytes: Uint8Array,
  targets: number[],
  degrees: 90 | 180 | 270,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  for (const n of targets) {
    const page = doc.getPage(n - 1);
    const cur = page.getRotation().angle;
    page.setRotation({ type: 'degrees', angle: (cur + degrees) % 360 } as never);
  }
  return doc.save({ useObjectStreams: false });
}

export async function splitByRanges(
  bytes: Uint8Array,
  ranges: number[][],
): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const out: Uint8Array[] = [];
  for (const range of ranges) {
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, range.map((n) => n - 1));
    for (const p of pages) doc.addPage(p);
    out.push(await doc.save({ useObjectStreams: false }));
  }
  return out;
}

export async function extractPages(bytes: Uint8Array, targets: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(src, targets.map((n) => n - 1));
  for (const p of pages) doc.addPage(p);
  return doc.save({ useObjectStreams: false });
}

// ---- AcroForm inspection + fill (phase 6a) — append-only section ----------
// Everything below is additive; existing exports above are frozen by the
// engine append-only invariant (AGENTS.md build invariants).

export interface FormTextFieldInfo {
  /** Fully qualified field name (unique key for fillTextFields). */
  name: string;
  /** /TU alternate (tooltip) name authored in the form; '' when absent. */
  label: string;
  /** 1-based page of the field's first widget; 0 when not on any page. */
  page: number;
  required: boolean;
  readOnly: boolean;
  multiline: boolean;
  /** Current /V value; '' when unset. */
  value: string;
}

export interface FormInspectResult {
  /** Catalog /AcroForm /XFA present — phase 6a refuses to fill these. */
  hasXFA: boolean;
  /** All fields regardless of type (drives the "no form" empty state). */
  totalFields: number;
  /** Fillable text fields only (phase 6a scope). */
  textFields: FormTextFieldInfo[];
}

/**
 * Inspects the AcroForm of a PDF without modifying it. Loads with
 * ignoreEncryption:false so encrypted input throws (the caller routes it to
 * the decrypt flow). Never calls getForm() when no /AcroForm exists — that
 * accessor would lazily CREATE one on the loaded doc.
 */
export async function inspectFormFields(bytes: Uint8Array): Promise<FormInspectResult> {
  const { PDFName, PDFDict, PDFString, PDFHexString, PDFRef, PDFArray, PDFTextField } =
    await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) return { hasXFA: false, totalFields: 0, textFields: [] };
  const hasXFA = acroForm.has(PDFName.of('XFA'));
  // XFA docs stop here: pdf-lib's getForm() path DELETES /XFA (with a
  // console.warn) as unsupported, and save() strips it silently — we must
  // report XFA before anything touches the form, and never fill these.
  if (hasXFA) return { hasXFA: true, totalFields: 0, textFields: [] };

  // Widget annotation ref -> 1-based page. Split fields keep their widgets in
  // /Kids, so field refs alone miss the page; kids cover that case.
  const pageOf = new Map<string, number>();
  doc.getPages().forEach((page, idx) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i += 1) {
      const ref = annots.get(i);
      if (ref instanceof PDFRef) pageOf.set(ref.toString(), idx + 1);
    }
  });

  const fields = doc.getForm().getFields();
  const textFields: FormTextFieldInfo[] = [];
  for (const field of fields) {
    if (!(field instanceof PDFTextField)) continue;
    const dict = field.acroField.dict;
    const widgetRefs: (string | undefined)[] = [field.acroField.ref?.toString()];
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (let i = 0; i < kids.size(); i += 1) {
        const ref = kids.get(i);
        if (ref instanceof PDFRef) widgetRefs.push(ref.toString());
      }
    }
    const page = widgetRefs.reduce<number>(
      (found, key) => found || (key ? (pageOf.get(key) ?? 0) : 0),
      0,
    );
    // /TU is a text string: either literal (PDFString) or hex (PDFHexString,
    // a PDFString subclass — the lookupMaybe overload matches both).
    const tu = dict.lookupMaybe(PDFName.of('TU'), PDFString, PDFHexString);
    const label = tu ? (tu instanceof PDFHexString ? tu.decodeText() : tu.asString()) : '';
    let value = '';
    try {
      value = field.getText() ?? '';
    } catch {
      value = ''; // corrupt /V — treat as empty rather than failing the list
    }
    textFields.push({
      name: field.getName(),
      label,
      page,
      required: field.isRequired(),
      readOnly: field.isReadOnly(),
      multiline: field.isMultiline(),
      value,
    });
  }
  return { hasXFA, totalFields: fields.length, textFields };
}

/**
 * Fills text fields with a subset-embedded Unicode font so Vietnamese
 * diacritics survive (standard WinAnsi fonts cannot encode them). Readonly and
 * unknown names are skipped. Keeps fields interactive — flatten is phase 6b.
 * Saves with useObjectStreams:false so the font dict (/FontFile2) is written
 * literally.
 */
export async function fillTextFields(
  bytes: Uint8Array,
  values: Record<string, string>,
  fontTtf: Uint8Array,
): Promise<Uint8Array> {
  const { PDFTextField } = await import('pdf-lib');
  const fontkit = await import('@pdf-lib/fontkit');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontTtf, { subset: true });
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (field instanceof PDFTextField && !field.isReadOnly()) {
      field.setText(value);
    }
  }
  form.updateFieldAppearances(font);
  // updateFieldAppearances:false — pdf-lib's save() default would run a SECOND
  // appearance pass with the doc's default font (Helvetica, WinAnsi) and throw
  // on any field still marked dirty with Vietnamese text. Our pass above
  // already regenerated every dirty field with the embedded font and marked
  // them clean; this flag makes the risky default pass a no-op.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
