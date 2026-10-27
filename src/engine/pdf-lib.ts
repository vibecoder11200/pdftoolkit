import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFString,
  degrees,
  rgb,
} from 'pdf-lib';
import { QpdfRewriteRefusedError, qpdfCanonicalUncompress, qpdfRewrite } from './qpdf';

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

// ---- AcroForm complete: every field type + flatten (phase 6b) — append-only
// Same append-only invariant as the 6a section above: the 6a exports
// (inspectFormFields / fillTextFields) stay byte-identical; 6b ships parallel
// unified exports so both generations keep their blast radius frozen.

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'signature'
  | 'other';

export interface FormFieldInfo {
  /** Fully qualified field name (unique key for fillFormFields). */
  name: string;
  /** /TU alternate (tooltip) name authored in the form; '' when absent. */
  label: string;
  /** 1-based page of the field's first widget; 0 when not on any page. */
  page: number;
  required: boolean;
  readOnly: boolean;
  type: FormFieldType;
  /** Display form of the current value ('' = unset; radio/dropdown joined). */
  value: string;
  /** text only. */
  multiline?: boolean;
  /** checkbox only: current on/off state. */
  checked?: boolean;
  /** radio/dropdown/optionlist only: choices (radio = export values). */
  options?: string[];
  /** dropdown/optionlist only: currently selected display values. */
  selected?: string[];
  /** dropdown only: combo box accepts custom (free-text) values. */
  editable?: boolean;
}

export interface FormInspectResultAll {
  hasXFA: boolean;
  /** All fields regardless of type (drives the "no form" empty state). */
  totalFields: number;
  /** Any /FT /Sig field present (R15: warn before fill, HARD warn before flatten). */
  hasSignature: boolean;
  fields: FormFieldInfo[];
}

export interface FormFillInput {
  texts?: Record<string, string>;
  checkboxes?: Record<string, boolean>;
  /** radio export value per group. */
  radios?: Record<string, string>;
  /** dropdown/optionlist display value(s); '' clears the selection. */
  choices?: Record<string, string | string[]>;
}

export interface FormFillOptions {
  /**
   * Bake field appearances into page content and remove the fields.
   * Irreversible; the UI must confirm (R15). Signature fields are never
   * baked or removed — but note pdf-lib save() REWRITES the whole file (no
   * incremental update), so any existing /ByteRange signature is void after
   * a fill+save regardless. Never call with flatten on a signed doc without
   * surfacing the R15 warning first.
   */
  flatten?: boolean;
}

export interface FormFillResult {
  bytes: Uint8Array;
  /**
   * Fields whose value set or appearance/flatten step failed (one broken
   * /DA or widget must not abort the save — R15 resilience). The UI lists
   * these in a notice; everything else still lands in the output.
   */
  skipped: string[];
}

/** Last `Tf` size in a /DA string; undefined when DA absent, NaN-safe. */
function daFontSize(da: string | undefined): number | undefined {
  if (!da) return undefined;
  let last: number | undefined;
  for (const m of da.matchAll(/([\d.]+)\s+Tf/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

function readDaString(dict: import('pdf-lib').PDFDict): string | undefined {
  const { PDFName, PDFString, PDFHexString } = pdfLibCache!;
  const da = dict.lookupMaybe(PDFName.of('DA'), PDFString, PDFHexString);
  if (!da) return undefined;
  return da instanceof PDFHexString ? da.decodeText() : da.asString();
}

// Module cache for the dynamic pdf-lib import shared by the 6b helpers —
// filled by inspectFormFieldsAll/fillFormFields before any helper runs.
let pdfLibCache: typeof import('pdf-lib') | null = null;

/**
 * Phase 6b multiline AUTO-size mitigation (chosen approach: force an explicit
 * font size at fill, mutating /DA — /NeedAppearances was rejected because it
 * makes the output depend on each viewer's generator and leaves flattening
 * with nothing to bake).
 *
 * Upstream bug (pdf-lib#1581 class): the appearance provider's AUTO size for
 * multiline text maximizes to the widget height (62pt text in a 72pt box).
 * We recompute the size with a DOWNWARD search from the authored size (or
 * 12pt when the field is AUTO) until the wrapped text fits the widget box,
 * floor 4pt, then rewrite /DA with the explicit size. Explicit-size fields
 * that already fit are left untouched (no regression of the correct path).
 */
function mitigateMultilineAutoSize(
  field: import('pdf-lib').PDFTextField,
  font: import('pdf-lib').PDFFont,
): void {
  const { layoutMultilineText } = pdfLibCache!;
  if (!field.isMultiline()) return;
  const text = field.getText() ?? '';
  if (!text) return;
  const acro = field.acroField;
  const widgets = acro.getWidgets();
  if (widgets.length === 0) return;
  const rect = widgets[0].getRectangle();
  const pad = 2; // border 1 + inner padding 1 — matches the provider minimums
  const bounds = {
    x: pad,
    y: pad,
    width: Math.max(rect.width - pad * 2, 4),
    height: Math.max(rect.height - pad * 2, 4),
  };
  // Provider precedence: widget /DA wins over field /DA.
  const widgetDa = readDaString(widgets[0].dict);
  const fieldDa = acro.getDefaultAppearance();
  const explicit = daFontSize(widgetDa) ?? daFontSize(fieldDa);
  const base = explicit !== undefined && explicit > 0 ? explicit : 12;
  let fitted: number | null = null;
  for (let size = Math.floor(base); size >= 4; size -= 1) {
    const layout = layoutMultilineText(text, {
      alignment: field.getAlignment(),
      fontSize: size,
      font,
      bounds,
    });
    if (layout.lines.length * layout.lineHeight <= bounds.height + 0.5) {
      fitted = size;
      break;
    }
  }
  const size = fitted ?? 4; // overflow floor — bounded, never the 62pt blowup
  if (explicit === size) return; // authored size already fits — leave /DA alone
  const rewrite = (dict: import('pdf-lib').PDFDict, da: string | undefined): void => {
    if (da && /Tf/.test(da)) setDaSize(dict, da, size);
  };
  // Provider precedence: widget /DA wins over field /DA — rewrite whichever
  // carries a Tf operator so the provider cannot read a stale size.
  rewrite(widgets[0].dict, widgetDa);
  rewrite(acro.dict, fieldDa);
  if (!/Tf/.test(fieldDa ?? '') && !/Tf/.test(widgetDa ?? '')) {
    acro.setDefaultAppearance(`0 0 0 rg /Helvetica ${size} Tf`);
  }
}

// Regex-based in-place Tf size swap for a /DA string (keeps color ops).
function setDaSize(dict: import('pdf-lib').PDFDict, da: string, size: number): void {
  const { PDFName, PDFString } = pdfLibCache!;
  const rewritten = da.replace(
    /\/(\w+)\s+[\d.]+\s+Tf(?![\s\S]*\/\w+\s+[\d.]+\s+Tf)/, // last Tf only
    (_m, name: string) => `/${name} ${size} Tf`,
  );
  dict.set(PDFName.of('DA'), PDFString.of(rewritten));
}

/**
 * Inspects every AcroForm field — text, checkbox, radio, dropdown, option
 * list, signature — without modifying the document. Loads with
 * ignoreEncryption:false so encrypted input throws (the caller routes it to
 * the decrypt flow). Refuses XFA exactly like inspectFormFields: pdf-lib
 * deletes /XFA as unsupported the moment getForm() runs, so the XFA check
 * must precede any form access.
 */
export async function inspectFormFieldsAll(bytes: Uint8Array): Promise<FormInspectResultAll> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const {
    PDFName,
    PDFDict,
    PDFString,
    PDFHexString,
    PDFRef,
    PDFArray,
    PDFTextField,
    PDFCheckBox,
    PDFRadioGroup,
    PDFDropdown,
    PDFOptionList,
    PDFSignature,
  } = pdfLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) return { hasXFA: false, totalFields: 0, hasSignature: false, fields: [] };
  const hasXFA = acroForm.has(PDFName.of('XFA'));
  if (hasXFA) return { hasXFA: true, totalFields: 0, hasSignature: false, fields: [] };

  // Widget annotation ref -> 1-based page (kids cover split fields).
  const pageOf = new Map<string, number>();
  doc.getPages().forEach((page, idx) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i += 1) {
      const ref = annots.get(i);
      if (ref instanceof PDFRef) pageOf.set(ref.toString(), idx + 1);
    }
  });

  const typeOf = (f: import('pdf-lib').PDFField): FormFieldType => {
    if (f instanceof PDFTextField) return 'text';
    if (f instanceof PDFCheckBox) return 'checkbox';
    if (f instanceof PDFRadioGroup) return 'radio';
    if (f instanceof PDFDropdown) return 'dropdown';
    if (f instanceof PDFOptionList) return 'optionlist';
    if (f instanceof PDFSignature) return 'signature';
    return 'other';
  };

  const fields: FormFieldInfo[] = [];
  let hasSignature = false;
  for (const field of doc.getForm().getFields()) {
    if (field instanceof PDFSignature) hasSignature = true;
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
    const tu = dict.lookupMaybe(PDFName.of('TU'), PDFString, PDFHexString);
    const label = tu ? (tu instanceof PDFHexString ? tu.decodeText() : tu.asString()) : '';

    const info: FormFieldInfo = {
      name: field.getName(),
      label,
      page,
      required: (() => {
        try {
          return field.isRequired();
        } catch {
          return false;
        }
      })(),
      readOnly: (() => {
        try {
          return field.isReadOnly();
        } catch {
          return false;
        }
      })(),
      type: typeOf(field),
      value: '',
    };
    try {
      if (field instanceof PDFTextField) {
        info.multiline = field.isMultiline();
        info.value = field.getText() ?? '';
      } else if (field instanceof PDFCheckBox) {
        info.checked = field.isChecked();
        info.value = field.isChecked() ? '\u2611' : '';
      } else if (field instanceof PDFRadioGroup) {
        info.options = field.getOptions();
        info.value = field.getSelected() ?? '';
      } else if (field instanceof PDFDropdown) {
        info.options = field.getOptions();
        info.selected = field.getSelected();
        info.editable = field.isEditable();
        info.value = info.selected.join(', ');
      } else if (field instanceof PDFOptionList) {
        info.options = field.getOptions();
        info.selected = field.getSelected();
        info.value = info.selected.join(', ');
      }
    } catch {
      // Corrupt /V or flags — surface the field with an empty value rather
      // than dropping it from the list (the user still sees its name/label).
    }
    fields.push(info);
  }
  return { hasXFA, totalFields: fields.length, hasSignature, fields };
}

/**
 * Fills every field type with a subset-embedded Unicode font (Vietnamese
 * diacritics survive — standard WinAnsi fonts cannot encode them), then
 * optionally flattens.
 *
 * Resilience (R15): each value set, each per-field appearance regeneration,
 * and each flatten step is individually wrapped — one field with a broken
 * /DA, missing /Rect or hostile option list lands in `skipped` and the save
 * proceeds. Appearances are regenerated per field (never via the global
 * PDFForm.updateFieldAppearances, whose all-or-nothing failure was the R15
 * incident). Signature fields are excluded from appearance updates and
 * flatten; see FormFillOptions.flatten for the signature caveat.
 *
 * Saves with useObjectStreams:false so the font dict (/FontFile2) stays
 * literal, and updateFieldAppearances:false so pdf-lib's default second pass
 * (Helvetica/WinAnsi, throws on VN text) never runs.
 */
export async function fillFormFields(
  bytes: Uint8Array,
  input: FormFillInput,
  fontTtf: Uint8Array,
  opts: FormFillOptions = {},
): Promise<FormFillResult> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const {
    PDFTextField,
    PDFCheckBox,
    PDFRadioGroup,
    PDFDropdown,
    PDFOptionList,
    PDFSignature,
  } = pdfLib;
  const fontkitNs = await import('@pdf-lib/fontkit');
  // CJS interop: under plain node the namespace buries the API behind
  // `default` (vitest/Vite hoist named exports). Resolve either shape.
  const fontkit: typeof fontkitNs =
    'create' in fontkitNs ? fontkitNs : (fontkitNs as { default: typeof fontkitNs }).default;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontTtf, { subset: true });
  const form = doc.getForm();
  const skipped = new Set<string>();

  const fieldMaybe = (name: string): import('pdf-lib').PDFField | undefined => {
    try {
      return form.getFieldMaybe(name);
    } catch {
      return undefined;
    }
  };

  // ---- 1) value sets (each isolated; readonly/unknown silently ignored —
  // the UI never sends them, matching the 6a contract) -----------------------
  const apply = (name: string, fn: () => void): void => {
    try {
      fn();
    } catch {
      skipped.add(name);
    }
  };
  for (const [name, value] of Object.entries(input.texts ?? {})) {
    apply(name, () => {
      const f = fieldMaybe(name);
      if (f instanceof PDFTextField && !f.isReadOnly()) f.setText(value);
    });
  }
  for (const [name, checked] of Object.entries(input.checkboxes ?? {})) {
    apply(name, () => {
      const f = fieldMaybe(name);
      if (f instanceof PDFCheckBox && !f.isReadOnly()) {
        if (checked) f.check();
        else f.uncheck();
      }
    });
  }
  for (const [name, value] of Object.entries(input.radios ?? {})) {
    apply(name, () => {
      const f = fieldMaybe(name);
      if (f instanceof PDFRadioGroup && !f.isReadOnly()) f.select(value);
    });
  }
  for (const [name, value] of Object.entries(input.choices ?? {})) {
    apply(name, () => {
      const f = fieldMaybe(name);
      const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== '');
      if (f instanceof PDFDropdown && !f.isReadOnly()) {
        if (values.length === 0) f.clear();
        else f.select(values);
      } else if (f instanceof PDFOptionList && !f.isReadOnly()) {
        if (values.length === 0) f.clear();
        else f.select(values);
      }
    });
  }

  // ---- 2) appearance regeneration, per field -------------------------------
  for (const field of form.getFields()) {
    if (field instanceof PDFSignature) continue; // R15: never touch /Sig fields
    let needs = true;
    try {
      needs = field.needsAppearancesUpdate();
    } catch {
      needs = true; // exotic subtype — attempt the update, catch below
    }
    if (!needs) continue;
    try {
      if (field instanceof PDFTextField) {
        mitigateMultilineAutoSize(field, font);
        field.defaultUpdateAppearances(font);
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        field.defaultUpdateAppearances(font);
      } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
        // Their appearance providers take no font (circles / check glyphs).
        field.defaultUpdateAppearances();
      }
      // Other subtypes (pushbuttons etc.) are left untouched.
    } catch {
      skipped.add(field.getName());
    }
  }

  // ---- 3) optional flatten: bake appearances, then remove fields -----------
  // Mirrors PDFForm.flatten() but per field with try/catch and a signature
  // exclusion, so one hostile widget cannot abort the bake (R15) and /Sig
  // fields survive as fields.
  if (opts.flatten) {
    const {
      pushGraphicsState,
      popGraphicsState,
      translate,
      drawObject,
      rotateInPlace,
      PDFName,
      PDFArray,
      PDFRef,
    } = pdfLib;
    // findWidgetPage/findWidgetAppearanceRef are runtime-public but typed
    // private in pdf-lib's d.ts — narrow structural cast (same pattern as the
    // PDFStreamWriter cast in tests/fill-form.spec.ts), never `any`.
    type FlattenInternals = {
      findWidgetPage(widget: object): import('pdf-lib').PDFPage;
      findWidgetAppearanceRef(field: object, widget: object): import('pdf-lib').PDFRef;
    };
    const internals = form as unknown as FlattenInternals;
    for (const field of [...form.getFields()]) {
      if (field instanceof PDFSignature) continue;
      try {
        // pdf-lib 1.17.1 always stores widgets under /Kids, and its
        // removeField() never touches those kid refs in page /Annots — a
        // plain flatten() leaves every widget annotation orphaned (and
        // dangling after its context.delete). Collect the true annot refs
        // and remove them from their pages ourselves.
        const kids = field.acroField.dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
        const kidRefs: (import('pdf-lib').PDFRef | undefined)[] = [];
        if (kids) {
          for (let i = 0; i < kids.size(); i += 1) {
            const ref = kids.get(i);
            kidRefs.push(ref instanceof PDFRef ? ref : undefined);
          }
        }
        const widgets = field.acroField.getWidgets();
        for (let i = 0; i < widgets.length; i += 1) {
          const widget = widgets[i];
          const page = internals.findWidgetPage(widget);
          const widgetRef = internals.findWidgetAppearanceRef(field, widget);
          const xObjectKey = page.node.newXObject('FlatWidget', widgetRef);
          const rect = widget.getRectangle();
          page.pushOperators(
            pushGraphicsState(),
            translate(rect.x, rect.y),
            ...rotateInPlace({ ...rect, rotation: 0 }),
            drawObject(xObjectKey),
            popGraphicsState(),
          );
          // Kid refs are the page annotations; merged-widget forms (foreign
          // producers) keep the annot on the field ref itself.
          const annotRef = kidRefs[i] ?? field.acroField.ref;
          if (annotRef) page.node.removeAnnot(annotRef);
        }
        form.removeField(field);
      } catch {
        skipped.add(field.getName());
      }
    }
  }

  return {
    bytes: await doc.save({ useObjectStreams: false, updateFieldAppearances: false }),
    skipped: [...skipped],
  };
}

// ---- Watermark + page numbers (v0.8.0 phase 1) — append-only section ------
// Same append-only invariant as the 6a/6b sections above.

import { renderPageTemplate } from '../lib/page-template';
import { isPngBytes } from '../lib/image-intake';

/** 9-grid anchor: row ∈ {top, middle, bottom} × col ∈ {left, center, right}. */
export type GridPos9 =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface WatermarkTextOptions {
  mode: 'text';
  text: string;
  fontSize: number;
  /** 0–1. */
  opacity: number;
  /** VISUAL rotation, degrees CLOCKWISE as the reader sees the displayed page. */
  rotation: number;
  position: GridPos9;
  /** Visual offsets in pt (right/down positive). */
  offsetX: number;
  offsetY: number;
  tiled?: boolean;
  /** 2–8 (engine clamps). */
  tileColumns?: number;
}

export interface WatermarkImageOptions {
  mode: 'image';
  /** PNG or JPEG bytes (header-sniffed here; intake gate lives in
   * src/lib/image-intake.ts and runs in the UI BEFORE these bytes exist). */
  imageBytes: Uint8Array;
  opacity: number;
  /** Image width as a fraction of the visible page's min dimension, 0–1. */
  scale: number;
  position: GridPos9;
  offsetX: number;
  offsetY: number;
}

export type StampWatermarkOptions =
  | ({ pages?: number[] } & WatermarkTextOptions)
  | ({ pages?: number[] } & WatermarkImageOptions);

export interface PageNumbersOptions {
  template: string;
  position: GridPos9;
  /** Distance of the stamp box from the visible page edges, pt. */
  margin: number;
  fontSize: number;
  /** {n} = actual page number + (startNumber − 1). */
  startNumber: number;
  /** Scope (sorted 1-based); undefined/empty = all. Skip-first = 2..N. */
  pages?: number[];
  /** Basename source for the {filename} token. */
  filename: string;
}

/**
 * pdf-lib geometry semantics, verified against the 1.17.1 sources before this
 * code was written (plan step 1 — do not "simplify" away):
 * - `page.getSize()`/`getWidth()`/`getHeight()` reflect the MEDIABOX.
 * - `page.getCropBox()` returns the CropBox when present (inheritable),
 *   else the MediaBox — always with its x/y ORIGIN, which can be non-zero.
 * - drawText/drawImage take RAW user-space coordinates: pdf-lib does NOT
 *   compensate for the MediaBox/CropBox origin and does NOT compensate for
 *   /Rotate (rotation is applied by the viewer at display time). Nothing in
 *   this repo compensated either (scout §9) — the transform below is the
 *   shared placement math for every future stamping feature (v0.9 annotate
 *   MUST reuse it, AGENTS.md invariant).
 */

export interface PageGeometry {
  /** Visible box (CropBox else MediaBox) in user space, including origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Effective /Rotate, normalized to 0|90|180|270. */
  rotate: 0 | 90 | 180 | 270;
  /** DISPLAYED dimensions: width/height swapped for 90/270. */
  visualWidth: number;
  visualHeight: number;
}

function normalizeRotate(angle: number): 0 | 90 | 180 | 270 {
  const a = ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  return a;
}

export function visibleGeometry(page: import('pdf-lib').PDFPage): PageGeometry {
  const box = page.getCropBox();
  const rotate = normalizeRotate(page.getRotation().angle);
  const swap = rotate === 90 || rotate === 270;
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotate,
    visualWidth: swap ? box.height : box.width,
    visualHeight: swap ? box.width : box.height,
  };
}

/**
 * Visual → user space. Visual coordinates are what the reader sees: origin
 * at the bottom-left of the DISPLAYED visible box, x right, y up.
 * Forward map (user rel → visual) for a page displayed with /Rotate r
 * degrees clockwise: r=90 → (y', w − x'); r=180 → (w − x', h − y');
 * r=270 → (h − y', x'). Inverted here (w/h are the user-space box dims,
 * visualWidth/Height the displayed dims — swapped for 90/270).
 */
export function visualToPageSpace(
  vx: number,
  vy: number,
  geom: PageGeometry,
): { x: number; y: number } {
  let lx: number;
  let ly: number;
  switch (geom.rotate) {
    case 90:
      lx = geom.visualHeight - vy;
      ly = vx;
      break;
    case 180:
      lx = geom.width - vx;
      ly = geom.height - vy;
      break;
    case 270:
      lx = vy;
      ly = geom.visualWidth - vx;
      break;
    default:
      lx = vx;
      ly = vy;
  }
  return { x: geom.x + lx, y: geom.y + ly };
}

/**
 * Draw angle for pdf-lib's CCW-positive `rotate` so the stamp VISUALLY
 * appears rotated `visualRotationCw` degrees clockwise: the viewer turns the
 * page `/Rotate` degrees clockwise on top of whatever user-space angle we
 * draw, so draw = pageRotate − visualRotationCw (mod 360).
 */
export function drawAngleFor(visualRotationCw: number, pageRotate: number): number {
  return (((pageRotate - visualRotationCw) % 360) + 360) % 360;
}

/**
 * Draw point (bottom-left of the stamp box) in VISUAL coordinates for a
 * 9-grid anchor, kept inside `margin` of the visible edges. Text passes its
 * measured width and treats the box height as the font size (baseline at the
 * box bottom — ascender approximated by the full size, well inside the
 * property-matrix tolerance).
 */
export function anchorPoint(
  pos: GridPos9,
  geom: PageGeometry,
  boxW: number,
  boxH: number,
  margin: number,
  offsetX = 0,
  offsetY = 0,
): { vx: number; vy: number } {
  const row = pos.startsWith('top') ? 'top' : pos === 'center' || pos.startsWith('middle') ? 'middle' : 'bottom';
  const col = pos.endsWith('left') ? 'left' : pos.endsWith('right') ? 'right' : 'center';
  const x =
    col === 'left'
      ? margin
      : col === 'right'
        ? geom.visualWidth - margin - boxW
        : (geom.visualWidth - boxW) / 2;
  const top =
    row === 'top'
      ? geom.visualHeight - margin
      : row === 'bottom'
        ? margin + boxH
        : (geom.visualHeight + boxH) / 2;
  return { vx: x + offsetX, vy: top - boxH + offsetY };
}

/** Engine-side scope clamp (finding 13 backstop): out-of-range entries are
 * FILTERED, never thrown; duplicates dropped; result sorted ascending. */
function selectPageIndices(doc: PDFDocument, pages?: number[]): number[] {
  const count = doc.getPageCount();
  if (!pages || pages.length === 0) return doc.getPageIndices();
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const n of pages) {
    const i = n - 1;
    if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) continue;
    seen.add(i);
    indices.push(i);
  }
  return indices.sort((a, b) => a - b);
}

async function embedRobotoSubset(doc: PDFDocument, fontTtf: Uint8Array): Promise<import('pdf-lib').PDFFont> {
  const fontkitNs = await import('@pdf-lib/fontkit');
  const fontkit: typeof fontkitNs =
    'create' in fontkitNs ? fontkitNs : (fontkitNs as { default: typeof fontkitNs }).default;
  doc.registerFontkit(fontkit);
  return doc.embedFont(fontTtf, { subset: true });
}

interface StampStyle {
  position: GridPos9;
  offsetX: number;
  offsetY: number;
  opacity: number;
  rotationCw: number;
}

const STAMP_GRAY = { r: 0.5, g: 0.5, b: 0.5 };

function stampTextOnPage(
  page: import('pdf-lib').PDFPage,
  font: import('pdf-lib').PDFFont,
  text: string,
  fontSize: number,
  style: StampStyle,
  margin: number,
): void {
  const geom = visibleGeometry(page);
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const draw = anchorPoint(style.position, geom, textWidth, fontSize, margin, style.offsetX, style.offsetY);
  const user = visualToPageSpace(draw.vx, draw.vy, geom);
  page.drawText(text, {
    x: user.x,
    y: user.y,
    font,
    size: fontSize,
    rotate: degrees(drawAngleFor(style.rotationCw, geom.rotate)),
    opacity: style.opacity,
    color: rgb(STAMP_GRAY.r, STAMP_GRAY.g, STAMP_GRAY.b),
  });
}

function stampTextTiledOnPage(
  page: import('pdf-lib').PDFPage,
  font: import('pdf-lib').PDFFont,
  text: string,
  fontSize: number,
  style: StampStyle,
  tileColumns: number,
): void {
  const geom = visibleGeometry(page);
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const cols = Math.min(8, Math.max(2, Math.round(tileColumns)));
  const tileW = geom.visualWidth / cols;
  const rows = Math.max(1, Math.round(geom.visualHeight / tileW));
  const tileH = geom.visualHeight / rows;
  const angle = degrees(drawAngleFor(style.rotationCw, geom.rotate));
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const cx = tileW * (c + 0.5) + style.offsetX;
      const cy = tileH * (r + 0.5) + style.offsetY;
      const user = visualToPageSpace(cx - textWidth / 2, cy - fontSize / 2, geom);
      page.drawText(text, {
        x: user.x,
        y: user.y,
        font,
        size: fontSize,
        rotate: angle,
        opacity: style.opacity,
        color: rgb(STAMP_GRAY.r, STAMP_GRAY.g, STAMP_GRAY.b),
      });
    }
  }
}

function stampImageOnPage(
  page: import('pdf-lib').PDFPage,
  image: import('pdf-lib').PDFImage,
  scale: number,
  style: StampStyle,
  margin: number,
): void {
  const geom = visibleGeometry(page);
  const src = image.size();
  const targetW = Math.max(1, scale * Math.min(geom.visualWidth, geom.visualHeight));
  const targetH = Math.max(1, targetW * (src.height / src.width));
  const draw = anchorPoint(style.position, geom, targetW, targetH, margin, style.offsetX, style.offsetY);
  const user = visualToPageSpace(draw.vx, draw.vy, geom);
  page.drawImage(image, {
    x: user.x,
    y: user.y,
    width: targetW,
    height: targetH,
    rotate: degrees(drawAngleFor(style.rotationCw, geom.rotate)),
    opacity: style.opacity,
  });
}

/**
 * Stamps a text or image watermark onto every in-scope page. Rotation- and
 * CropBox-aware: placement is specified in VISUAL coordinates and mapped
 * through visibleGeometry/visualToPageSpace, so a "top-right" stamp lands
 * top-right on screen for every /Rotate × CropBox combination (property-test
 * matrix in tests/watermark-engine.spec.ts, pdf.js as the independent
 * oracle). Loads with ignoreEncryption:false — an encrypted input throws the
 * typed EncryptedPDFError the UI routes to the decrypt flow (no swallowing).
 */
export async function stampWatermark(
  bytes: Uint8Array,
  opts: StampWatermarkOptions,
  fontTtf: Uint8Array,
): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument } = pdfLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  let font: import('pdf-lib').PDFFont | null = null;
  let image: import('pdf-lib').PDFImage | null = null;
  if (opts.mode === 'text') {
    font = await embedRobotoSubset(doc, fontTtf);
  } else {
    image = isPngBytes(opts.imageBytes)
      ? await doc.embedPng(opts.imageBytes)
      : await doc.embedJpg(opts.imageBytes);
  }
  const style: StampStyle = {
    position: opts.position,
    offsetX: opts.offsetX,
    offsetY: opts.offsetY,
    opacity: opts.opacity,
    rotationCw: opts.mode === 'text' ? opts.rotation : 0,
  };
  for (const index of selectPageIndices(doc, opts.pages)) {
    const page = doc.getPage(index);
    if (opts.mode === 'text') {
      if (opts.tiled) {
        stampTextTiledOnPage(page, font!, opts.text, opts.fontSize, style, opts.tileColumns ?? 3);
      } else {
        stampTextOnPage(page, font!, opts.text, opts.fontSize, style, 0);
      }
    } else if (image) {
      stampImageOnPage(page, image, opts.scale, style, 0);
    }
  }
  // v0.8.1 ownership tag: reverseOwnWatermark reverses exactly this op (the
  // tag is truth; heuristic matching is only for foreign watermarks).
  writeWmTag(doc, wmTagOf(opts, selectPageIndices(doc, opts.pages)));
  return doc.save({ useObjectStreams: false });
}

/**
 * Renders `template` per in-scope page (renderPageTemplate — pure module,
 * zero pdf-lib imports) and draws the result through the same rotation-aware
 * placement primitives as stampWatermark. {n} = actual page number +
 * (startNumber − 1); {total} = full page count regardless of scope. Same
 * ignoreEncryption:false + scope-clamping contract as stampWatermark.
 */
export async function applyPageNumbers(
  bytes: Uint8Array,
  opts: PageNumbersOptions,
  fontTtf: Uint8Array,
): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument } = pdfLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const font = await embedRobotoSubset(doc, fontTtf);
  const total = doc.getPageCount();
  const style: StampStyle = {
    position: opts.position,
    offsetX: 0,
    offsetY: 0,
    opacity: 1,
    rotationCw: 0,
  };
  for (const index of selectPageIndices(doc, opts.pages)) {
    const label = renderPageTemplate(opts.template, {
      n: index + 1 + (opts.startNumber - 1),
      total,
      filename: opts.filename,
    });
    stampTextOnPage(doc.getPage(index), font, label, opts.fontSize, style, opts.margin);
  }
  return doc.save({ useObjectStreams: false });
}

// ---- Watermark removal (v0.8.1 phase 2) — append-only section -------------
// Ported from the phase-1 spike (temp/spikes/wm-removal/proto.mjs, GO
// verdict: 5/5 gating classes clean, zero content damage against the pdf.js
// oracle). Two passes over every decoded content stream:
//   Pass 1 classifies each BT..ET block's show ops:
//     - semantic: the operand decodes to the hint (latin1 or UTF-16BE) —
//       covers standard fonts (Helvetica literal text);
//     - structural: single-show block, Tf size >= 16 (or === sizePin for
//       tagged reversal), operand GLYPH COUNT == hint char length, and the
//       (size, operandHex) tuple repeated across pages — covers
//       subset-encoded fonts (@pdf-lib/fontkit cannot even READ a subset's
//       name table, so cmap-decoding is unusable; the spike proved this).
//   Pass 2 removes a block ONLY when FULLY matched (a block mixing matching
//   and non-matching shows is never touched) and re-emits the stream
//   UNCOMPRESSED (delete /Filter). Spike discovery #1 is load-bearing: the
//   font resource name must NOT be part of the structural key — pdf-lib
//   names the same font object differently on every page.
// Conservatism invariant (phase-2 doc): never remove a block containing
// mixed content; any parse anomaly throws typed with the output untouched.

// fflate 0.8.x: inflateSync decodes RAW deflate — PDF /FlateDecode is the
// zlib wrapper format (RFC 1950), so the correct decoder is unzlibSync.
import { unzlibSync } from 'fflate';

export interface RemoveWatermarkOptions {
  /** Exact watermark text — the matching hint (required for untagged PDFs). */
  hint: string;
  /** 1-based page scope (sorted, clamped); undefined/empty = all pages. */
  pages?: number[];
}

export interface ReverseOwnWatermarkOptions {
  /** 1-based page scope, intersected with the tagged pages; default = tagged. */
  pages?: number[];
}

/** Nothing matched the hint/tag — honest failure, output untouched. */
export class WatermarkNotFoundError extends Error {
  constructor(message = 'No watermark blocks matched the given hint.') {
    super(message);
    this.name = 'WatermarkNotFoundError';
  }
}

/** Parse anomaly mid-scan (e.g. a corrupt FlateDecode stream) — typed so the
 * caller can distinguish "engine bug/foreign oddity" from "no watermark". */
export class WatermarkParseError extends Error {
  constructor(message = 'PDF parse anomaly while scanning for watermarks.') {
    super(message);
    this.name = 'WatermarkParseError';
  }
}

/** reverseOwnWatermark on a file without (or with an unusable) pdftoolkit-wm
 * tag — the UI falls back to the heuristic path when a hint was given. */
export class NotOwnWatermarkError extends Error {
  constructor(message = 'Not a file watermarked reversibly by PDF Toolkit.') {
    super(message);
    this.name = 'NotOwnWatermarkError';
  }
}

/** Custom Info-dict key carrying the ownership tag (JSON in a UTF-16BE
 * PDFHexString — safe transport for Vietnamese text). */
const WM_TAG_KEY = 'pdftoolkit-wm';

interface WmOwnershipTag {
  v: 1;
  mode: 'text' | 'image';
  /** Text-mode: the stamped string (the removal hint). */
  text?: string;
  /** Text-mode: the font size (exact structural pin for reversal). */
  size?: number;
  /** Text-mode: whether the stamp was tiled. */
  tiled?: boolean;
  /** Stamped pages, 1-based ascending (empty = all pages). */
  pages: number[];
}

function wmTagOf(opts: StampWatermarkOptions, indices: number[]): WmOwnershipTag {
  const pages = indices.map((i) => i + 1);
  return opts.mode === 'text'
    ? { v: 1, mode: 'text', text: opts.text, size: opts.fontSize, tiled: !!opts.tiled, pages }
    : { v: 1, mode: 'image', pages };
}

/** Same access pdf-lib's private getInfoDict() performs (its TS type is
 * private): reuse the parsed /Info dict, else create + register one. */
function infoDictOf(doc: PDFDocument): import('pdf-lib').PDFDict {
  const { PDFDict } = pdfLibCache!;
  const existing = doc.context.lookup(doc.context.trailerInfo.Info);
  if (existing instanceof PDFDict) return existing;
  const dict = doc.context.obj({});
  doc.context.trailerInfo.Info = doc.context.register(dict);
  return dict;
}

function writeWmTag(doc: PDFDocument, tag: WmOwnershipTag): void {
  const { PDFName, PDFHexString } = pdfLibCache!;
  infoDictOf(doc).set(PDFName.of(WM_TAG_KEY), PDFHexString.fromText(JSON.stringify(tag)));
}

/** null = absent, malformed, or foreign-shaped (treated as "not ours"). */
function readWmTag(doc: PDFDocument): WmOwnershipTag | null {
  const { PDFName, PDFDict, PDFHexString } = pdfLibCache!;
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) return null;
  const raw = info.lookupMaybe(PDFName.of(WM_TAG_KEY), PDFHexString);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.decodeText()) as Partial<WmOwnershipTag>;
    if (parsed?.v !== 1 || (parsed.mode !== 'text' && parsed.mode !== 'image')) return null;
    const pages = Array.isArray(parsed.pages)
      ? parsed.pages.filter((n): n is number => Number.isInteger(n) && n >= 1)
      : [];
    return { ...parsed, pages } as WmOwnershipTag;
  } catch {
    return null;
  }
}

function deleteWmTag(doc: PDFDocument): void {
  const { PDFName } = pdfLibCache!;
  infoDictOf(doc).delete(PDFName.of(WM_TAG_KEY));
}

// ---- byte/latin1 helpers (Buffer-free: this module runs in the worker AND
// on the main thread via the fill-form path) ----

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf8').decode(bytes);
}

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function utf16beOf(bytes: Uint8Array): string {
  let r = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) r += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return r;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

/** PDF literal string operand (incl. outer parens) → raw bytes. Escapes per
 * the spec: \n \r \t \b \f, octal \ddd, and pass-through \<char>. */
function decodeLiteralOperand(literal: string): Uint8Array {
  const inner = literal.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\') {
      const n = inner[++i];
      if (n === 'n') bytes.push(10);
      else if (n === 'r') bytes.push(13);
      else if (n === 't') bytes.push(9);
      else if (n === 'b') bytes.push(8);
      else if (n === 'f') bytes.push(12);
      else if (n >= '0' && n <= '7') {
        let oct = n;
        while (oct.length < 3 && inner[i + 1] >= '0' && inner[i + 1] <= '7') oct += inner[++i];
        bytes.push(parseInt(oct, 8));
      } else bytes.push(n.charCodeAt(0));
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

/** Content streams of a page (Contents may be one stream or an array). Only
 * PDFRawStream counts — a loaded doc never carries authored PDFContentStream
 * objects; anything else is skipped (conservative, never an error). */
function pageContentStreams(
  doc: PDFDocument,
  page: import('pdf-lib').PDFPage,
): { stream: import('pdf-lib').PDFRawStream; flate: boolean }[] {
  const { PDFName, PDFArray, PDFRawStream } = pdfLibCache!;
  const streams: { stream: import('pdf-lib').PDFRawStream; flate: boolean }[] = [];
  const isFlate = (s: import('pdf-lib').PDFRawStream) =>
    String(s.dict.get(PDFName.of('Filter')) ?? '') === '/FlateDecode';
  const contents = doc.context.lookup(page.node.get(PDFName.of('Contents')));
  if (contents instanceof PDFRawStream) streams.push({ stream: contents, flate: isFlate(contents) });
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const s = doc.context.lookup(contents.get(i));
      if (s instanceof PDFRawStream) streams.push({ stream: s, flate: isFlate(s) });
    }
  }
  return streams;
}

/** Decoded stream text (latin1 — one byte per char, byte-exact for content
 * operators). A corrupt FlateDecode stream is a typed parse anomaly. */
function streamOpsText(stream: import('pdf-lib').PDFRawStream, flate: boolean): string {
  let raw: Uint8Array = stream.contents;
  if (flate) {
    try {
      raw = unzlibSync(stream.contents);
    } catch (e) {
      throw new WatermarkParseError(
        `FlateDecode inflate failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return bytesToLatin1(raw);
}

const WM_BLOCK_RE = /BT[\s\S]*?ET/g;
const WM_SHOW_RE = /\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;
const WM_TF_RE = /\/([A-Za-z0-9#+.\-]+)\s+([\d.]+)\s+Tf/;

interface WmBlockEntry {
  block: string;
  /** Structural key `${size}|${operandHex}` (null when not a candidate). */
  key: string | null;
  /** Every show in the block decoded to the hint. */
  semantic: boolean;
}

interface WmRemoveConfig {
  hint: string;
  /** 0-based page indices where blocks may be REMOVED. */
  scope: Set<number>;
  /** Structural keys need presence on >= threshold pages (spike rule). */
  threshold: number;
  /** Tagged reversal: exact Tf size — replaces the >= 16 guard. */
  sizePin?: number;
}

/**
 * The spike's two-pass matcher. Returns the removed-block count (0 = nothing
 * matched — callers throw WatermarkNotFoundError and leave the input alone).
 */
function removeWatermarkBlocks(doc: PDFDocument, cfg: WmRemoveConfig): number {
  const { PDFName, PDFNumber } = pdfLibCache!;
  const hintLen = [...cfg.hint].length;
  const perStream = new Map<
    import('pdf-lib').PDFRawStream,
    { flate: boolean; entries: WmBlockEntry[] }
  >();
  const keyPages = new Map<string, Set<number>>();
  doc.getPages().forEach((page, pi) => {
    for (const { stream, flate } of pageContentStreams(doc, page)) {
      const ops = streamOpsText(stream, flate);
      let rec = perStream.get(stream);
      if (!rec) {
        rec = { flate, entries: [] };
        perStream.set(stream, rec);
      }
      for (const b of ops.matchAll(WM_BLOCK_RE)) {
        const block = b[0];
        const tf = block.match(WM_TF_RE);
        const shows = [...block.matchAll(WM_SHOW_RE)];
        if (shows.length === 0) continue; // no text shows (e.g. image Do) — untouched
        let semantic = 0;
        let structuralKey: string | null = null;
        for (const s of shows) {
          let operand: Uint8Array;
          let hex: string;
          if (s[1] !== undefined) {
            hex = s[1].replace(/\s+/g, '');
            operand = hexToBytes(hex);
          } else {
            operand = decodeLiteralOperand(s[0].slice(0, s[0].lastIndexOf(')') + 1));
            hex = bytesToHex(operand);
          }
          if (bytesToLatin1(operand) === cfg.hint || utf16beOf(operand) === cfg.hint) {
            semantic += 1;
            continue;
          }
          const size = tf ? Number(tf[2]) : 0;
          const glyphCount = hex.length / 4;
          const sizeOk = cfg.sizePin !== undefined ? size === cfg.sizePin : size >= 16;
          if (shows.length === 1 && sizeOk && glyphCount === hintLen) {
            // Discovery #1: pdf-lib gives the SAME font object a DIFFERENT
            // resource name per page — the font name must NOT be in the key.
            structuralKey = `${size}|${hex}`;
          }
        }
        const isSemantic = semantic === shows.length && semantic > 0;
        if (cfg.scope.has(pi)) rec.entries.push({ block, key: structuralKey, semantic: isSemantic });
        if (structuralKey && !isSemantic) {
          const set = keyPages.get(structuralKey) ?? new Set<number>();
          set.add(pi);
          keyPages.set(structuralKey, set);
        }
      }
    }
  });
  let removed = 0;
  for (const [stream, { flate, entries }] of perStream) {
    let ops = streamOpsText(stream, flate);
    let changed = false;
    for (const e of entries) {
      const present =
        e.semantic || (e.key !== null && (keyPages.get(e.key)?.size ?? 0) >= cfg.threshold);
      if (present && ops.includes(e.block)) {
        ops = ops.replace(e.block, '');
        changed = true;
        removed += 1;
      }
    }
    if (changed) {
      const out = latin1ToBytes(ops);
      // Re-emit uncompressed; /Length is also recomputed by pdf-lib at save
      // (PDFStream.updateDict) — set explicitly to mirror the spike.
      (stream as { contents: Uint8Array }).contents = out; // readonly in the .d.ts only
      stream.dict.delete(PDFName.of('Filter'));
      stream.dict.set(PDFName.of('Length'), PDFNumber.of(out.length));
    }
  }
  return removed;
}

/**
 * Heuristic watermark removal for FOREIGN (untagged) PDFs: user hint + the
 * spike's matching rules. Structural keys count over ALL pages (a watermark
 * is a doc-wide repetition; scoping narrows REMOVAL only, never the
 * watermark-ness signal). Typed failures: WatermarkNotFoundError (nothing
 * matched), WatermarkParseError (parse anomaly — output untouched). Loads
 * with ignoreEncryption:false — encrypted input propagates to the UI's
 * decrypt flow.
 */
export async function removeWatermark(
  bytes: Uint8Array,
  opts: RemoveWatermarkOptions,
): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument } = pdfLib;
  const hint = opts.hint.trim();
  if (!hint) throw new WatermarkNotFoundError('Empty watermark hint.');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const threshold = Math.max(2, Math.ceil(doc.getPageCount() * 0.8));
  const scope = new Set(selectPageIndices(doc, opts.pages));
  const removed = removeWatermarkBlocks(doc, { hint, scope, threshold });
  if (removed === 0) throw new WatermarkNotFoundError();
  return doc.save({ useObjectStreams: false });
}

/**
 * Exact reversal of a PDF Toolkit watermark: the pdftoolkit-wm tag is truth.
 * Uses the tagged text as the hint with the size pinned EXACTLY (tighter
 * structural key than the >= 16 heuristic) and no cross-page threshold; the
 * scope is the tagged pages (optionally narrowed). On success the tag is
 * deleted. Absent/malformed/image-mode tag → NotOwnWatermarkError; nothing
 * found → WatermarkNotFoundError — both leave the input untouched.
 */
export async function reverseOwnWatermark(
  bytes: Uint8Array,
  opts: ReverseOwnWatermarkOptions = {},
): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument } = pdfLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const tag = readWmTag(doc);
  // Image-mode tags are recorded for honesty but v0.8.1 removes TEXT only
  // (spike C4: image stamps draw outside BT..ET — different machinery).
  if (!tag || tag.mode !== 'text' || typeof tag.text !== 'string' || typeof tag.size !== 'number') {
    throw new NotOwnWatermarkError(
      tag?.mode === 'image'
        ? 'The tagged watermark is image-mode; only text removal is supported.'
        : undefined,
    );
  }
  const pageCount = doc.getPageCount();
  const taggedPages = tag.pages.length > 0 ? tag.pages : Array.from({ length: pageCount }, (_, i) => i + 1);
  const userScope = new Set(selectPageIndices(doc, opts.pages));
  const scope = new Set(taggedPages.map((n) => n - 1).filter((i) => i >= 0 && i < pageCount && userScope.has(i)));
  const removed = removeWatermarkBlocks(doc, {
    hint: tag.text,
    scope,
    threshold: 1, // the tag is truth — no cross-page repetition requirement
    sizePin: tag.size,
  });
  if (removed === 0) {
    throw new WatermarkNotFoundError(
      'The tagged watermark blocks were not found (the file may have been re-processed).',
    );
  }
  deleteWmTag(doc);
  return doc.save({ useObjectStreams: false });
}

// ═══════════════════════════ Redact engine (v0.9.0 phase 2) ═══════════════════════════

type PO = import('pdf-lib').PDFObject;
// Promoted from the GO spike (plans/reports/spike-redact-2026-10-25.md). The
// security contract: `redactFinalize` is the ONLY op whose output may reach
// deliverBytes — its tail is always pdf-lib full rewrite → internal qpdf
// rewrite (orphan GC) → scoped decompressed byte-scan. Never incremental
// saves. The v0.8.1 watermark machinery above is deliberately untouched (its
// /BT[\s\S]*?ET/ regex is fragile for hints containing "ET" — spike finding 1;
// this section's walker is token-aware instead).

/** Parse anomaly mid-pipeline — output untouched (WatermarkParseError pattern). */
export class RedactParseError extends Error {
  constructor(message = 'PDF parse anomaly while redacting.') {
    super(message);
    this.name = 'RedactParseError';
  }
}

/** Refusal BEFORE any mutation: encrypted input, signed input, vertical text,
 * a marked page the pipeline cannot clean surgically and has no raster JPEG
 * for, or a qpdf rewrite the file cannot survive (exit 2). */
export class RedactRefusedError extends Error {
  constructor(message = 'The file cannot be redacted safely.') {
    super(message);
    this.name = 'RedactRefusedError';
  }
}

/** Post-output verification failure (scoped decompressed byte-scan hit) —
 * the output is discarded, never returned. Rasterize cannot fix object-level
 * residue, so there is no retry at this leg (finding 4). */
export class RedactVerifyError extends Error {
  constructor(message = 'Redaction verification failed — output discarded.') {
    super(message);
    this.name = 'RedactVerifyError';
  }
}

/** Visual-space rectangle (displayed page: origin bottom-left of the visible
 * box, x right, y up — the space pdf.js items and the user's drags live in). */
export interface RedactRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RedactSurgicalPage {
  /** 1-based page number. */
  page: number;
  rects: RedactRect[];
}

// ─────────────────────────── census ───────────────────────────

/** Construct hits that force the rasterize-or-refuse tier (finding 7) —
 * extraction-visible does not mean surgically-removable. */
export type RedactCensusKind =
  | 'type3'
  | 'font-no-tounicode'
  | 'actualtext'
  | 'tr3'
  | 'pattern-text'
  | 'xobject-text'
  | 'vertical-text'
  | 'oc-props'
  | 'widget'
  | 'annot-text'
  | 'annot-hidden'
  | 'annot-ap-text'
  | 'stream-undecodable';

export interface RedactCensusReport {
  pageCount: number;
  /** Only pages WITH hits are listed. */
  pages: { page: number; kinds: RedactCensusKind[] }[];
  /** Doc-level channels present and scrub-able (id form: 'info:Author',
   * 'xmp', 'outlines', 'names:JavaScript', 'names:EmbeddedFiles',
   * 'acroform:V', 'structtree'). */
  docChannels: string[];
}

function redactDecodeString(obj: unknown): string | null {
  try {
    if (obj instanceof PDFHexString || obj instanceof PDFString) return obj.decodeText();
  } catch {
    /* malformed string — treat as absent */
  }
  return null;
}

/** Read-only whole-document construct census (spike promotion). */
export async function redactCensus(bytes: Uint8Array): Promise<RedactCensusReport> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument, PDFArray, PDFDict, PDFName } = pdfLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageHits = new Map<number, RedactCensusKind[]>();
  const flag = (p1: number, kind: RedactCensusKind): void => {
    const list = pageHits.get(p1) ?? [];
    if (!list.includes(kind)) list.push(kind);
    pageHits.set(p1, list);
  };
  const hasShowOps = (text: string): boolean =>
    /(?:\)|>|\])\s*(?:Tj|TJ)\b|(?:\)|>)\s*'/.test(text.replace(/\s+/g, ' '));

  doc.getPages().forEach((page, pi) => {
    const p1 = pi + 1;
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    if (res instanceof PDFDict) {
      const fonts = doc.context.lookup(res.get(PDFName.of('Font')));
      if (fonts instanceof PDFDict) {
        for (const [, v] of fonts.entries()) {
          const fd = doc.context.lookup(v);
          if (!(fd instanceof PDFDict)) continue;
          const sub = String(fd.get(PDFName.of('Subtype')) ?? '');
          if (sub === '/Type3') flag(p1, 'type3');
          if (Number(fd.get(PDFName.of('Wmode')) ?? 0) === 1) flag(p1, 'vertical-text');
          if ((sub === '/Type0' || sub === '/TrueType') && !fd.get(PDFName.of('ToUnicode'))) {
            flag(p1, 'font-no-tounicode');
          }
        }
      }
      const walkXObjects = (dict: unknown, depth: number): void => {
        if (!(dict instanceof PDFDict) || depth > 4) return;
        for (const [, v] of dict.entries()) {
          const s = doc.context.lookup(v);
          if (!(s instanceof PDFRawStream)) continue;
          if (String(s.dict.get(PDFName.of('Subtype')) ?? '') === '/Form') {
            const text = redactStreamText(s);
            if (text !== null && hasShowOps(text)) flag(p1, 'xobject-text');
            const inner = doc.context.lookup(s.dict.get(PDFName.of('Resources')));
            if (inner instanceof PDFDict) walkXObjects(doc.context.lookup(inner.get(PDFName.of('XObject'))), depth + 1);
          }
        }
      };
      const xobjs = doc.context.lookup(res.get(PDFName.of('XObject')));
      if (xobjs instanceof PDFDict) walkXObjects(xobjs, 0);
      const pats = doc.context.lookup(res.get(PDFName.of('Pattern')));
      if (pats instanceof PDFDict) {
        for (const [, v] of pats.entries()) {
          const s = doc.context.lookup(v);
          if (s instanceof PDFRawStream && Number(s.dict.get(PDFName.of('PatternType')) ?? -1) === 1) {
            const text = redactStreamText(s);
            if (text !== null && hasShowOps(text)) flag(p1, 'pattern-text');
          }
        }
      }
    }
    for (const { stream } of pageContentStreams(doc, page)) {
      const text = redactStreamText(stream);
      if (text === null) {
        flag(p1, 'stream-undecodable');
        continue;
      }
      if (text.includes('/ActualText')) flag(p1, 'actualtext');
      if (/(^|[^\d])3\s+Tr(?![\d])/.test(text)) flag(p1, 'tr3');
    }
    if (page.node.get(PDFName.of('Properties'))) flag(p1, 'oc-props');
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i += 1) {
        const a = doc.context.lookup(annots.get(i));
        if (!(a instanceof PDFDict)) continue;
        if (String(a.get(PDFName.of('Subtype')) ?? '') === '/Widget') flag(p1, 'widget');
        if (Number(a.get(PDFName.of('F')) ?? 0) & 2) flag(p1, 'annot-hidden');
        const c = redactDecodeString(a.get(PDFName.of('Contents')));
        if (c && c.trim().length > 0) flag(p1, 'annot-text');
        const ap = doc.context.lookup(a.get(PDFName.of('AP')));
        if (ap instanceof PDFDict) {
          for (const key of ['N', 'D', 'R'] as const) {
            const s = doc.context.lookup(ap.get(PDFName.of(key)));
            if (s instanceof PDFRawStream) {
              const text = redactStreamText(s);
              if (text !== null && hasShowOps(text)) flag(p1, 'annot-ap-text');
            }
          }
        }
      }
    }
  });

  const docChannels: string[] = [];
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const [k, v] of info.entries()) {
      const s = redactDecodeString(v);
      if (s && s.trim().length > 0) docChannels.push(`info:${k.toString().replace(/^\//, '')}`);
    }
  }
  if (doc.catalog.get(PDFName.of('Metadata'))) docChannels.push('xmp');
  if (doc.catalog.get(PDFName.of('Outlines'))) docChannels.push('outlines');
  const names = doc.context.lookup(doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict) {
    if (names.get(PDFName.of('JavaScript'))) docChannels.push('names:JavaScript');
    if (names.get(PDFName.of('EmbeddedFiles'))) docChannels.push('names:EmbeddedFiles');
  }
  if (doc.catalog.get(PDFName.of('AcroForm'))) docChannels.push('acroform:V');
  if (doc.catalog.get(PDFName.of('StructTreeRoot'))) docChannels.push('structtree');

  return {
    pageCount: doc.getPageCount(),
    pages: [...pageHits.entries()].map(([page, kinds]) => ({ page, kinds })).sort((a, b) => a.page - b.page),
    docChannels,
  };
}

/** Decoded stream text for the redact section — reuses the watermark
 * machinery's inflate + typed-anomaly convention, but re-emits as null so
 * census can flag undecodable streams instead of failing the whole run. */
function redactStreamText(stream: import('pdf-lib').PDFRawStream): string | null {
  const flate = String(stream.dict.get(PDFName.of('Filter')) ?? '') === '/FlateDecode';
  try {
    return streamOpsText(stream, flate);
  } catch {
    return null;
  }
}

// ─────────────────────────── token walker (spike promotion) ───────────────────────────

type RedactToken =
  | { t: 'num'; v: string; i: number }
  | { t: 'name'; v: string; i: number }
  | { t: 'str'; v: string; i: number }
  | { t: 'hex'; v: string; i: number }
  | { t: 'op'; v: string; i: number }
  | { t: 'dict'; v: '<<'; i: number }
  | { t: 'dictend'; v: '>>'; i: number }
  | { t: 'arr'; v: '['; i: number }
  | { t: 'arre'; v: ']'; i: number; elems: RedactToken[] };

/** Content-stream tokenizer (latin1) — literal strings with nesting + escapes,
 * hex strings, names, numbers, arrays (elements ride the matching ']' token). */
function redactTokenize(text: string): RedactToken[] {
  const toks: RedactToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      let out = '';
      while (j < n && depth > 0) {
        const c = text[j];
        if (c === '\\') {
          out += c + (text[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
        out += c;
        j += 1;
      }
      if (depth !== 0) throw new RedactParseError('Unterminated literal string in content stream.');
      toks.push({ t: 'str', v: `(${out})`, i });
      i = j + 1;
      continue;
    }
    if (ch === '<' && text[i + 1] !== '<') {
      const j = text.indexOf('>', i);
      if (j < 0) throw new RedactParseError('Unterminated hex string in content stream.');
      toks.push({ t: 'hex', v: text.slice(i, j + 1), i });
      i = j + 1;
      continue;
    }
    if (ch === '<') {
      toks.push({ t: 'dict', v: '<<', i });
      i += 2;
      continue;
    }
    if (ch === '>' && text[i + 1] === '>') {
      toks.push({ t: 'dictend', v: '>>', i });
      i += 2;
      continue;
    }
    if (ch === '[') {
      toks.push({ t: 'arr', v: '[', i });
      i += 1;
      continue;
    }
    if (ch === ']') {
      // attach the elements that appeared since the matching '['
      let depth = 1;
      let k = toks.length - 1;
      while (k >= 0) {
        const t = toks[k];
        if (t.t === 'arre') depth += 1;
        else if (t.t === 'arr') {
          depth -= 1;
          if (depth === 0) break;
        }
        k -= 1;
      }
      const elems = k >= 0 ? toks.slice(k + 1) : [];
      if (k < 0) throw new RedactParseError('Unmatched ] in content stream.');
      toks.splice(k + 1);
      toks.push({ t: 'arre', v: ']', i, elems });
      i += 1;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !/[\s/[\]<>(){}]/.test(text[j])) j += 1;
      toks.push({ t: 'name', v: text.slice(i, j), i });
      i = j;
      continue;
    }
    if (/[-+.\d]/.test(ch)) {
      let j = i;
      while (j < n && /[-+.\d]/.test(text[j])) j += 1;
      toks.push({ t: 'num', v: text.slice(i, j), i });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !/[\s/[\]<>()]/.test(text[j])) j += 1;
    toks.push({ t: 'op', v: text.slice(i, j), i });
    i = j;
  }
  return toks;
}

function redactDecodeOperand(tok: RedactToken & { t: 'str' | 'hex' }): Uint8Array {
  const s = tok.v;
  if (tok.t === 'hex') {
    const clean = s.slice(1, -1).replace(/\s+/g, '');
    const out = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '\\') {
      const nx = inner[++i];
      if (nx === 'n') bytes.push(10);
      else if (nx === 'r') bytes.push(13);
      else if (nx === 't') bytes.push(9);
      else if (nx === 'b') bytes.push(8);
      else if (nx === 'f') bytes.push(12);
      else if (nx >= '0' && nx <= '7') {
        let oct = nx;
        while (oct.length < 3 && inner[i + 1] >= '0' && inner[i + 1] <= '7') oct += inner[++i];
        bytes.push(parseInt(oct, 8));
      } else bytes.push(nx.charCodeAt(0) & 0xff);
    } else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

/** Operand text: UTF-16BE with BOM → text; otherwise latin1 (WinAnsi/simple
 * fonts; subset-CID glyph bytes stay opaque — matching happens geometrically). */
function redactOperandText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let r = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) r += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return r;
  }
  return bytesToLatin1(bytes);
}

/** a,b,c,d,e,f column-vector convention. */
function redactMul(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function redactApply(m: number[], x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

interface RedactShow {
  text: string;
  size: number;
  trm: number[];
  nglyphs: number;
}

const REDACT_PENDING_MAX = 8;

/** Numeric operands immediately before an operator (bounded backward scan). */
function redactPendingNums(toks: RedactToken[], opIdx: number): number[] {
  const out: number[] = [];
  let j = opIdx - 1;
  while (j >= 0 && toks[j].t === 'num' && out.length <= REDACT_PENDING_MAX) {
    out.unshift(Number(toks[j].v));
    j -= 1;
  }
  return out;
}
function redactPendingName(toks: RedactToken[], beforeIdx: number): string | null {
  let j = beforeIdx;
  while (j >= 0) {
    const t = toks[j];
    if (t.t === 'name') return t.v;
    if (t.t !== 'num') return null;
    j -= 1;
  }
  return null;
}

/** Interprets ONE BT..ET block: every show op with its text-render matrix.
 * Throw-typed on structural anomalies (conservatism invariant 4). */
function redactBlockShows(block: string): RedactShow[] {
  const toks = redactTokenize(block);
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let size = 0;
  const shows: RedactShow[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i];
    if (tok.t !== 'op') continue;
    switch (tok.v) {
      case 'Tf': {
        const pending = redactPendingNums(toks, i);
        const name = redactPendingName(toks, i - pending.length);
        if (name && pending.length >= 1) size = pending[pending.length - 1];
        break;
      }
      case 'Tm': {
        const pending = redactPendingNums(toks, i);
        if (pending.length >= 6) {
          tm = pending.slice(-6);
          tlm = tm.slice();
        } else throw new RedactParseError('Tm with fewer than 6 operands.');
        break;
      }
      case 'Td': {
        const pending = redactPendingNums(toks, i);
        if (pending.length >= 2) {
          const [tx, ty] = pending.slice(-2);
          tlm = redactMul([1, 0, 0, 1, tx, ty], tlm);
          tm = tlm.slice();
        } else throw new RedactParseError('Td with fewer than 2 operands.');
        break;
      }
      case 'TD': {
        const pending = redactPendingNums(toks, i);
        if (pending.length >= 2) {
          const [tx, ty] = pending.slice(-2);
          leading = -ty;
          tlm = redactMul([1, 0, 0, 1, tx, ty], tlm);
          tm = tlm.slice();
        } else throw new RedactParseError('TD with fewer than 2 operands.');
        break;
      }
      case 'TL': {
        const pending = redactPendingNums(toks, i);
        if (pending.length >= 1) leading = pending[pending.length - 1];
        break;
      }
      case 'T*': {
        tlm = redactMul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice();
        break;
      }
      case 'Tj':
      case "'":
      case '"': {
        const nums = redactPendingNums(toks, i);
        let j = i - nums.length - 1;
        let sTok: (RedactToken & { t: 'str' | 'hex' }) | null = null;
        while (j >= 0) {
          const t = toks[j];
          if (t.t === 'str' || t.t === 'hex') {
            sTok = t;
            break;
          }
          if (t.t !== 'num') break;
          j -= 1;
        }
        if (!sTok) throw new RedactParseError(`Show op ${tok.v} without a string operand.`);
        if (tok.v !== 'Tj') {
          tlm = redactMul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm.slice();
        }
        const bytes = redactDecodeOperand(sTok);
        shows.push({
          text: redactOperandText(bytes),
          size,
          trm: tm.slice(),
          nglyphs: sTok.t === 'hex' ? Math.max(1, bytes.length / 2) : Math.max(1, bytes.length),
        });
        break;
      }
      case 'TJ': {
        let j = i - 1;
        while (j >= 0 && toks[j].t !== 'arre') j -= 1;
        if (j < 0) throw new RedactParseError('TJ without an array operand.');
        const elems = (toks[j] as { elems: RedactToken[] }).elems.filter(
          (e): e is RedactToken & { t: 'str' | 'hex' } => e.t === 'str' || e.t === 'hex',
        );
        if (elems.length === 0) break;
        let text = '';
        for (const e of elems) text += redactOperandText(redactDecodeOperand(e));
        shows.push({ text, size, trm: tm.slice(), nglyphs: Math.max(1, text.length) });
        break;
      }
      default:
        break;
    }
  }
  return shows;
}

/** CTM at a given byte offset (q/Q/cm replay over the token stream prefix). */
function redactCtmBefore(toks: RedactToken[], offset: number): number[] {
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < toks.length && toks[i].i < offset; i += 1) {
    const tok = toks[i];
    if (tok.t !== 'op') continue;
    if (tok.v === 'q') stack.push(ctm.slice());
    else if (tok.v === 'Q') ctm = stack.pop() ?? ctm;
    else if (tok.v === 'cm') {
      const pending = redactPendingNums(toks, i);
      if (pending.length >= 6) ctm = redactMul(pending.slice(-6), ctm);
    }
  }
  return ctm;
}

interface RedactStreamOp {
  stream: import('pdf-lib').PDFRawStream;
  flate: boolean;
}

function redactPageStreams(doc: PDFDocument, page: import('pdf-lib').PDFPage): RedactStreamOp[] {
  return pageContentStreams(doc, page).map(({ stream, flate }) => ({ stream, flate }));
}

// ─────────────────────────── surgical walker ───────────────────────────

const REDACT_W_FACTOR = 0.55; // avg glyph-width estimate (fallback only)
const REDACT_CONTAIN_TOL = 6; // pt containment tolerance

export interface RedactSurgicalOutcome {
  /** Pages refused (partial block / anomaly) — caller must supply raster. */
  refusedPages: number[];
  removedBlocks: number;
}

/**
 * TJ-aware surgical removal on the census-CLEAN pages of `scope`. A BT..ET
 * block is removed ONLY when every show touching a rect lies FULLY inside one
 * (spike-classified); any partial coverage refuses the page. Token-aware BT..ET
 * ranges — the v0.8.1 block regex breaks on secrets containing "ET"
 * (spike finding 1). Rects are VISUAL-space; mapping goes through the shared
 * geometry primitives (invariant 3).
 */
function redactSurgicalRemove(
  doc: PDFDocument,
  scope: Map<number, RedactRect[]>, // 0-based page index → visual rects
): RedactSurgicalOutcome {
  const refusedPages: number[] = [];
  let removedBlocks = 0;
  const removals: { stream: RedactStreamOp; block: string }[] = [];

  doc.getPages().forEach((page, pi) => {
    const rectsVisual = scope.get(pi);
    if (!rectsVisual || rectsVisual.length === 0) return;
    const eg = visibleGeometry(page);
    const rectsUser = rectsVisual.map((r) => {
      const corners = [
        visualToPageSpace(r.x, r.y, eg),
        visualToPageSpace(r.x + r.w, r.y, eg),
        visualToPageSpace(r.x, r.y + r.h, eg),
        visualToPageSpace(r.x + r.w, r.y + r.h, eg),
      ];
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      return {
        x0: Math.min(...xs) - REDACT_CONTAIN_TOL,
        y0: Math.min(...ys) - REDACT_CONTAIN_TOL,
        x1: Math.max(...xs) + REDACT_CONTAIN_TOL,
        y1: Math.max(...ys) + REDACT_CONTAIN_TOL,
      };
    });
    const inAnyRect = (b: { x: number; y: number; w: number; h: number }): boolean =>
      rectsUser.some((r) => b.x >= r.x0 && b.y >= r.y0 && b.x + b.w <= r.x1 && b.y + b.h <= r.y1);
    const touchesAnyRect = (b: { x: number; y: number; w: number; h: number }): boolean =>
      rectsUser.some((r) => b.x < r.x1 && b.x + b.w > r.x0 && b.y < r.y1 && b.y + b.h > r.y0);

    let pageRefused = false;
    for (const { stream, flate } of redactPageStreams(doc, page)) {
      const text = redactStreamText(stream);
      if (text === null) {
        pageRefused = true;
        continue;
      }
      const toks = redactTokenize(text);
      let btIdx = -1;
      for (const tok of toks) {
        if (tok.t === 'op' && tok.v === 'BT') {
          btIdx = tok.i;
          continue;
        }
        if (!(tok.t === 'op' && tok.v === 'ET' && btIdx >= 0)) continue;
        const blockStart = btIdx;
        const block = text.slice(btIdx, tok.i + 2);
        btIdx = -1;
        const ctm = redactCtmBefore(toks, blockStart);
        let shows: RedactShow[];
        try {
          shows = redactBlockShows(block);
        } catch (e) {
          if (e instanceof RedactParseError) {
            pageRefused = true;
            continue;
          }
          throw e;
        }
        if (shows.length === 0) continue;
        let touched = false;
        let ok = true;
        for (const s of shows) {
          const w = REDACT_W_FACTOR * s.size * s.nglyphs;
          const dirLen = Math.hypot(s.trm[0], s.trm[1]) || 1;
          const ux = s.trm[0] / dirLen;
          const uy = s.trm[1] / dirLen;
          const cornersUser = [
            redactApply(ctm, s.trm[4], s.trm[5]),
            redactApply(ctm, s.trm[4] + ux * w, s.trm[5] + uy * w),
            redactApply(ctm, s.trm[4] - uy * -0.25 * s.size, s.trm[5] + ux * -0.25 * s.size),
            redactApply(ctm, s.trm[4] + ux * w - uy * -0.25 * s.size, s.trm[5] + uy * w + ux * -0.25 * s.size),
            redactApply(ctm, s.trm[4] - uy * 0.85 * s.size, s.trm[5] + ux * 0.85 * s.size),
            redactApply(ctm, s.trm[4] + ux * w - uy * 0.85 * s.size, s.trm[5] + uy * w + ux * 0.85 * s.size),
          ];
          const xs = cornersUser.map((c) => c.x);
          const ys = cornersUser.map((c) => c.y);
          const box = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs),
            h: Math.max(...ys) - Math.min(...ys),
          };
          const inside = inAnyRect(box);
          if (inside || touchesAnyRect(box)) {
            touched = true;
            if (!inside) ok = false;
          }
        }
        if (touched && !ok) pageRefused = true;
        else if (touched && ok) removals.push({ stream: { stream, flate }, block });
      }
    }
    if (pageRefused) refusedPages.push(pi);
  });

  // replace AFTER the scan (multiple removals may target one stream)
  const byStream = new Map<RedactStreamOp, string[]>();
  for (const r of removals) {
    const list = byStream.get(r.stream) ?? [];
    list.push(r.block);
    byStream.set(r.stream, list);
  }
  for (const [op, blocks] of byStream) {
    let text = redactStreamText(op.stream);
    if (text === null) continue;
    for (const b of blocks) {
      if (!text.includes(b)) continue;
      text = text.replace(b, '');
      removedBlocks += 1;
    }
    const out = latin1ToBytes(text);
    (op.stream as { contents: Uint8Array }).contents = out; // readonly in .d.ts only
    op.stream.dict.delete(PDFName.of('Filter'));
    op.stream.dict.set(PDFName.of('Length'), PDFNumber.of(out.length));
  }
  return { refusedPages, removedBlocks };
}

// ─────────────────────────── images / annots / scrub / raster ───────────────────────────

/** Deep clone of a PDF object graph for copy-on-write (refs stay refs). */
function redactCloneObject(doc: PDFDocument, value: unknown): import('pdf-lib').PDFObject {
  if (value instanceof PDFDict) {
    const out = PDFDict.withContext(doc.context);
    for (const [k, v] of value.entries()) {
      out.set(PDFName.of(k.toString().slice(1)), redactCloneObject(doc, v));
    }
    return out;
  }
  if (value instanceof PDFArray) {
    const out = PDFArray.withContext(doc.context);
    for (let i = 0; i < value.size(); i += 1) {
      out.push(redactCloneObject(doc, doc.context.lookup(value.get(i))));
    }
    return out;
  }
  return value as import('pdf-lib').PDFObject;
}

/**
 * Removes image XObjects whose paint rectangle (CTM at `Do` time) intersects
 * a redact rect on their page — a painted-over image keeps its pixels in the
 * file, so true redaction must drop the object (the Do op AND the resource
 * entry; /SMask + /Alternates die in the qpdf GC pass as unreferenced).
 * Pages without their own /Resources get a per-page copy first (inherited-
 * resources retirement), so trimming never mutates sibling pages.
 */
function redactRetireImages(doc: PDFDocument, scope: Map<number, RedactRect[]>): number {
  let retired = 0;
  doc.getPages().forEach((page, pi) => {
    const rectsVisual = scope.get(pi);
    if (!rectsVisual || rectsVisual.length === 0) return;
    // ensure an OWN resources dict (copy-on-write from inherited)
    if (!page.node.get(PDFName.of('Resources'))) {
      const inherited = page.node.getInheritableAttribute(PDFName.of('Resources'));
      if (inherited) {
        page.node.set(PDFName.of('Resources'), doc.context.register(redactCloneObject(doc, inherited)));
      }
    }
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    if (!(res instanceof PDFDict)) return;
    const xobjs = doc.context.lookup(res.get(PDFName.of('XObject')));
    if (!(xobjs instanceof PDFDict)) return;
    const kill = new Set<string>();
    for (const { stream } of redactPageStreams(doc, page)) {
      const text = redactStreamText(stream);
      if (text === null) continue;
      const toks = redactTokenize(text);
      let pendingName: string | null = null;
      let pendingNums: number[] = [];
      const stack: number[][] = [];
      let ctm = [1, 0, 0, 1, 0, 0];
      for (const tok of toks) {
        if (tok.t === 'name') {
          pendingName = tok.v;
          continue;
        }
        if (tok.t === 'num') {
          pendingNums.push(Number(tok.v));
          if (pendingNums.length > 6) pendingNums = pendingNums.slice(-6);
          continue;
        }
        if (tok.t !== 'op') continue;
        if (tok.v === 'q') stack.push(ctm.slice());
        else if (tok.v === 'Q') ctm = stack.pop() ?? ctm;
        else if (tok.v === 'cm' && pendingNums.length >= 6) ctm = redactMul(pendingNums.slice(-6), ctm);
        else if (tok.v === 'Do' && pendingName) {
          const xo = doc.context.lookup(xobjs.get(PDFName.of(pendingName)));
          if (xo instanceof PDFRawStream && String(xo.dict.get(PDFName.of('Subtype')) ?? '') === '/Image') {
            const pts = [
              redactApply(ctm, 0, 0),
              redactApply(ctm, 1, 0),
              redactApply(ctm, 0, 1),
              redactApply(ctm, 1, 1),
            ];
            const xs = pts.map((p) => p.x);
            const ys = pts.map((p) => p.y);
            const box = {
              x: Math.min(...xs),
              y: Math.min(...ys),
              w: Math.max(...xs) - Math.min(...xs),
              h: Math.max(...ys) - Math.min(...ys),
            };
            const eg = visibleGeometry(page);
            for (const r of rectsVisual) {
              const c1 = visualToPageSpace(r.x, r.y, eg);
              const c2 = visualToPageSpace(r.x + r.w, r.y + r.h, eg);
              const ux0 = Math.min(c1.x, c2.x);
              const ux1 = Math.max(c1.x, c2.x);
              const uy0 = Math.min(c1.y, c2.y);
              const uy1 = Math.max(c1.y, c2.y);
              if (box.x < ux1 && box.x + box.w > ux0 && box.y < uy1 && box.y + box.h > uy0) {
                kill.add(pendingName);
                break;
              }
            }
          }
        }
        pendingName = null;
        pendingNums = [];
      }
    }
    for (const name of kill) {
      xobjs.delete(PDFName.of(name));
      retired += 1;
    }
  });
  return retired;
}

/**
 * Drops annotations overlapping any redact rect on their page (their text is
 * not page content — the walker cannot clean it). Widgets escalate to FIELD
 * level: the field leaves /AcroForm /Fields together with ALL sibling widgets
 * (finding 7). Returns the surfaced disposition list.
 */
function redactDisposeAnnots(
  doc: PDFDocument,
  scope: Map<number, RedactRect[]>,
): { page: number; dropped: number; fields: string[] }[] {
  const deadFields = new Set<unknown>(); // field dict objects (identity)
  const out: { page: number; dropped: number; fields: string[] }[] = [];

  const fieldRoot = (annot: import('pdf-lib').PDFDict): import('pdf-lib').PDFDict => {
    let cur = annot;
    for (let d = 0; d < 8; d += 1) {
      const parent = doc.context.lookup(cur.get(PDFName.of('Parent')));
      if (parent instanceof PDFDict) cur = parent;
      else break;
    }
    return cur;
  };

  doc.getPages().forEach((page, pi) => {
    const rectsVisual = scope.get(pi);
    if (!rectsVisual || rectsVisual.length === 0) return;
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return;
    const eg = visibleGeometry(page);
    const keep: unknown[] = [];
    const fields: string[] = [];
    let dropped = 0;
    for (let i = 0; i < annots.size(); i += 1) {
      const a = doc.context.lookup(annots.get(i));
      let drop = false;
      if (a instanceof PDFDict) {
        const rect = a.get(PDFName.of('Rect'));
        if (rect instanceof PDFArray && rect.size() >= 4) {
          const x0 = Number(rect.get(0));
          const y0 = Number(rect.get(1));
          const x1 = Number(rect.get(2));
          const y1 = Number(rect.get(3));
          for (const r of rectsVisual) {
            const c1 = visualToPageSpace(r.x, r.y, eg);
            const c2 = visualToPageSpace(r.x + r.w, r.y + r.h, eg);
            const ux0 = Math.min(c1.x, c2.x);
            const ux1 = Math.max(c1.x, c2.x);
            const uy0 = Math.min(c1.y, c2.y);
            const uy1 = Math.max(c1.y, c2.y);
            if (x0 < ux1 && x1 > ux0 && y0 < uy1 && y1 > uy0) {
              drop = true;
              break;
            }
          }
        }
        if (drop && String(a.get(PDFName.of('Subtype')) ?? '') === '/Widget') {
          const root = fieldRoot(a);
          deadFields.add(root);
          const t = redactDecodeString(root.get(PDFName.of('T')));
          if (t && !fields.includes(t)) fields.push(t);
        }
      }
      if (drop) dropped += 1;
      else keep.push(annots.get(i));
    }
    const keptArr = PDFArray.withContext(doc.context);
    for (const ref of keep) keptArr.push(ref as import('pdf-lib').PDFObject);
    page.node.set(PDFName.of('Annots'), keptArr);
    if (dropped > 0) out.push({ page: pi + 1, dropped, fields });
  });

  // field-level removal: drop dead fields (and whole dead subtrees) from /AcroForm
  if (deadFields.size > 0) {
    const acro = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
    if (acro instanceof PDFDict) {
      const fields = doc.context.lookup(acro.get(PDFName.of('Fields')));
      if (fields instanceof PDFArray) {
        const keep: PO[] = [];
        const walk = (ref: PO): boolean => {
          const d = doc.context.lookup(ref);
          if (!(d instanceof PDFDict)) return true;
          if (deadFields.has(d)) return false;
          const kids = doc.context.lookup(d.get(PDFName.of('Kids')) as PO);
          if (kids instanceof PDFArray) {
            const liveKids = PDFArray.withContext(doc.context);
            for (let i = 0; i < kids.size(); i += 1) {
              const kid = kids.get(i) as PO;
              if (walk(kid)) liveKids.push(kid);
            }
            if (liveKids.size() !== kids.size()) d.set(PDFName.of('Kids'), liveKids);
          }
          return true;
        };
        for (let i = 0; i < fields.size(); i += 1) {
          if (walk(fields.get(i))) keep.push(fields.get(i));
        }
        const keptFields = PDFArray.withContext(doc.context);
        for (const ref of keep) keptFields.push(ref as import('pdf-lib').PDFObject);
        acro.set(PDFName.of('Fields'), keptFields);
      }
    }
  }
  return out;
}

export interface RedactScrubAction {
  channel: string;
  /** Matched value prefix (surfaced to the user — never silent, finding 2). */
  sample: string;
}

/**
 * Doc-level scrub, scrub-ON-MATCH against `secrets` (finding 4: a duplicate
 * on an unredacted page is untouched; doc channels are the leak surface).
 * `skip` removes channels from scrubbing (surfaced list — the UI decides).
 */
function redactScrubDocChannels(
  doc: PDFDocument,
  secrets: string[],
  skip: ReadonlySet<string>,
): RedactScrubAction[] {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber } = pdfLibCache!;
  const actions: RedactScrubAction[] = [];
  const hit = (s: string): string | null => secrets.find((x) => s.includes(x)) ?? null;
  if (skip.size <= 0 || !skip.has('all')) {
    // /Info
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (info instanceof PDFDict) {
      for (const [k, v] of [...info.entries()]) {
        const s = redactDecodeString(v);
        const m = s ? hit(s) : null;
        if (m && !skip.has(`info:${k.toString().replace(/^\//, '')}`)) {
          info.delete(k);
          actions.push({ channel: `info:${k.toString().replace(/^\//, '')}`, sample: m.slice(0, 24) });
        }
      }
    }
    // XMP
    const meta = doc.context.lookup(doc.catalog.get(PDFName.of('Metadata')));
    if (meta instanceof PDFRawStream) {
      const text = bytesToUtf8(meta.contents);
      if (text) {
        const m = hit(text);
        if (m && !skip.has('xmp')) {
          let replaced = text;
          for (const s of secrets) replaced = replaced.split(s).join('[REDACTED]');
          const out = utf8ToBytes(replaced);
          (meta as { contents: Uint8Array }).contents = new Uint8Array(out);
          meta.dict.set(PDFName.of('Length'), PDFNumber.of(out.length));
          meta.dict.delete(PDFName.of('Filter'));
          actions.push({ channel: 'xmp', sample: m.slice(0, 24) });
        }
      }
    }
    // Outlines chain surgery
    const outlines = doc.context.lookup(doc.catalog.get(PDFName.of('Outlines')));
    if (outlines instanceof PDFDict && !skip.has('outlines')) {
      let prevRef: PO | null = null;
      let firstRef: PO | null = (outlines.get(PDFName.of('First')) ?? null) as PO | null;
      let curRef: PO | null = firstRef;
      const seen = new Set<unknown>();
      let count = 0;
      while (curRef) {
        const node = doc.context.lookup(curRef);
        if (!(node instanceof PDFDict) || seen.has(node)) break;
        seen.add(node);
        const t = redactDecodeString(node.get(PDFName.of('Title')));
        const nextRef = (node.get(PDFName.of('Next')) ?? null) as PO | null;
        const m = t ? hit(t) : null;
        if (m) {
          actions.push({ channel: 'outlines', sample: m.slice(0, 24) });
          if (prevRef) {
            const prev = doc.context.lookup(prevRef);
            if (prev instanceof PDFDict) prev.set(PDFName.of('Next'), nextRef ?? PDFNull);
          } else firstRef = nextRef;
        } else {
          count += 1;
          prevRef = curRef;
        }
        curRef = nextRef;
      }
      outlines.set(PDFName.of('First'), firstRef ?? PDFNull);
      outlines.set(PDFName.of('Last'), prevRef ?? PDFNull);
      outlines.set(PDFName.of('Count'), PDFNumber.of(count));
    }
    // /Names trees
    const names = doc.context.lookup(doc.catalog.get(PDFName.of('Names')));
    if (names instanceof PDFDict) {
      for (const tree of ['JavaScript', 'EmbeddedFiles'] as const) {
        if (skip.has(`names:${tree}`)) continue;
        const t = doc.context.lookup(names.get(PDFName.of(tree)));
        const arr = t instanceof PDFDict ? doc.context.lookup(t.get(PDFName.of('Names'))) : null;
        if (!(arr instanceof PDFArray)) continue;
        const keep: unknown[] = [];
        let removed = 0;
        for (let i = 0; i < arr.size(); i += 2) {
          const name = redactDecodeString(arr.get(i)) ?? '';
          const val = doc.context.lookup(arr.get(i + 1));
          let valText = '';
          if (val instanceof PDFDict) {
            valText += redactDecodeString(val.get(PDFName.of('JS'))) ?? '';
            valText += redactDecodeString(val.get(PDFName.of('F'))) ?? '';
            valText += redactDecodeString(val.get(PDFName.of('UF'))) ?? '';
            const ef = doc.context.lookup(val.get(PDFName.of('EF')));
            if (ef instanceof PDFDict) {
              for (const key of ['F', 'UF'] as const) {
                const st = doc.context.lookup(ef.get(PDFName.of(key)));
                if (st instanceof PDFRawStream) {
                  const inner = redactStreamText(st);
                  if (inner !== null) valText += inner;
                  else valText += bytesToLatin1(st.contents);
                }
              }
            }
          }
          const m = hit(name) ?? (valText ? hit(valText) : null);
          if (m) {
            removed += 1;
            actions.push({ channel: `names:${tree}`, sample: m.slice(0, 24) });
          } else {
            keep.push(arr.get(i), arr.get(i + 1));
          }
        }
        if (removed > 0 && t instanceof PDFDict) {
          const namesArr = PDFArray.withContext(doc.context);
          for (const ref of keep) namesArr.push(ref as import('pdf-lib').PDFObject);
          t.set(PDFName.of('Names'), namesArr);
          const limits = PDFArray.withContext(doc.context);
          if (keep.length >= 2) {
            limits.push(keep[0] as import('pdf-lib').PDFObject);
            limits.push(keep[keep.length - 2] as import('pdf-lib').PDFObject);
          }
          t.set(PDFName.of('Limits'), limits);
        }
      }
    }
    // AcroForm /V /DV
    const acro = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
    if (acro instanceof PDFDict && !skip.has('acroform:V')) {
      const fields = doc.context.lookup(acro.get(PDFName.of('Fields')));
      const walkField = (d: unknown, depth: number): void => {
        if (!(d instanceof PDFDict) || depth > 8) return;
        for (const key of ['V', 'DV'] as const) {
          const s = redactDecodeString(d.get(PDFName.of(key)));
          const m = s ? hit(s) : null;
          if (m) {
            d.delete(PDFName.of(key));
            actions.push({ channel: 'acroform:V', sample: m.slice(0, 24) });
          }
        }
        const kids = doc.context.lookup(d.get(PDFName.of('Kids')));
        if (kids instanceof PDFArray) {
          for (let i = 0; i < kids.size(); i += 1) walkField(doc.context.lookup(kids.get(i)), depth + 1);
        }
      };
      if (fields instanceof PDFArray) {
        for (let i = 0; i < fields.size(); i += 1) walkField(doc.context.lookup(fields.get(i)), 0);
      }
    }
    // StructTree /Alt /ActualText
    const st = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot')));
    if (st instanceof PDFDict && !skip.has('structtree')) {
      const walkStruct = (d: unknown, depth: number): void => {
        if (!(d instanceof PDFDict) || depth > 10) return;
        for (const key of ['Alt', 'ActualText'] as const) {
          const s = redactDecodeString(d.get(PDFName.of(key)));
          const m = s ? hit(s) : null;
          if (m) {
            d.delete(PDFName.of(key));
            actions.push({ channel: 'structtree', sample: m.slice(0, 24) });
          }
        }
        const kids = doc.context.lookup(d.get(PDFName.of('K')));
        if (kids instanceof PDFArray) {
          for (let i = 0; i < kids.size(); i += 1) walkStruct(doc.context.lookup(kids.get(i)), depth + 1);
        } else walkStruct(kids, depth + 1);
      };
      walkStruct(st, 0);
    }
  }
  return actions;
}

/**
 * Raster page replacement, SAME page object (page refs and the outline
 * stay valid): /Contents ← `q W 0 0 H 0 0 cm /Im0 Do Q`, /Resources
 * {XObject:{Im0}} ONLY (everything else dies in the GC pass), MediaBox =
 * [0 0 W H] with W/H the DISPLAYED dims, CropBox equal, /Rotate 0, /Annots
 * dropped. The JPEG must already carry the painted rects (finding 1 — the
 * wrapper paints pre-encode).
 */
async function redactReplacePageWithRaster(
  doc: PDFDocument,
  page: import('pdf-lib').PDFPage,
  jpeg: Uint8Array,
): Promise<void> {
  const { PDFName, PDFRawStream, PDFNumber } = pdfLibCache!;
  const eg = visibleGeometry(page);
  const W = eg.visualWidth;
  const H = eg.visualHeight;
  const embedded = await doc.embedJpg(jpeg);
  const ops = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  const content = PDFRawStream.of(doc.context.obj({ Length: ops.length }), latin1ToBytes(ops));
  const contentRef = doc.context.register(content);
  page.node.set(PDFName.of('Contents'), contentRef);
  const imgName = PDFName.of('Im0');
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { [imgName.toString().slice(1)]: embedded.ref } }),
  );
  page.node.set(
    PDFName.of('MediaBox'),
    doc.context.obj([0, 0, W, H].map((n) => PDFNumber.of(n))),
  );
  page.node.set(
    PDFName.of('CropBox'),
    doc.context.obj([0, 0, W, H].map((n) => PDFNumber.of(n))),
  );
  page.node.set(PDFName.of('Rotate'), PDFNumber.of(0));
  page.node.delete(PDFName.of('Annots'));
}

// ─────────────────────────── byte-scan (scoped, decompressed) ───────────────────────────

/** Needle encodings for a secret (finding 3): raw utf8, UTF-16BE ±BOM, and
 * the hex TEXT of both byte forms. */
function redactNeedles(secrets: string[]): { enc: string; bytes: Uint8Array }[] {
  const needles: { enc: string; bytes: Uint8Array }[] = [];
  for (const s of secrets) {
    if (!s) continue;
    const utf8 = utf8ToBytes(s);
    const u16 = new Uint8Array(s.length * 2);
    const dv = new DataView(u16.buffer);
    for (let i = 0; i < s.length; i += 1) dv.setUint16(i * 2, s.charCodeAt(i), false);
    const u16bom = new Uint8Array(2 + u16.length);
    u16bom[0] = 0xfe;
    u16bom[1] = 0xff;
    u16bom.set(u16, 2);
    needles.push({ enc: 'utf8', bytes: utf8 });
    needles.push({ enc: 'utf16be', bytes: u16 });
    needles.push({ enc: 'utf16be-bom', bytes: u16bom });
    needles.push({ enc: 'hex-utf8', bytes: latin1ToBytes(bytesToHex(utf8)) });
    needles.push({ enc: 'hex-utf16be', bytes: latin1ToBytes(bytesToHex(u16)) });
  }
  return needles;
}

interface RedactHygieneBlob {
  where: string;
  bytes: Uint8Array;
}

async function redactCollectScopedBlobs(
  doc: PDFDocument,
  affectedPages: number[], // 1-based
): Promise<RedactHygieneBlob[]> {
  const { PDFName, PDFDict, PDFArray, PDFRawStream } = pdfLibCache!;
  const blobs: RedactHygieneBlob[] = [];
  const addText = (where: string, text: string | null): void => {
    if (text !== null) blobs.push({ where, bytes: latin1ToBytes(text) });
  };
  const addStream = (where: string, s: unknown): void => {
    if (!(s instanceof PDFRawStream)) return;
    const text = redactStreamText(s);
    if (text !== null) addText(where, text);
    else blobs.push({ where, bytes: s.contents });
  };
  const walkResources = (resRef: unknown, where: string, depth: number): void => {
    const res = doc.context.lookup(resRef as import('pdf-lib').PDFObject);
    if (!(res instanceof PDFDict) || depth > 5) return;
    const fonts = doc.context.lookup(res.get(PDFName.of('Font')));
    if (fonts instanceof PDFDict) {
      for (const [k, v] of fonts.entries()) {
        const fd = doc.context.lookup(v);
        if (!(fd instanceof PDFDict)) continue;
        addStream(`${where}/Font${k}/ToUnicode`, doc.context.lookup(fd.get(PDFName.of('ToUnicode'))));
      }
    }
    const xobjs = doc.context.lookup(res.get(PDFName.of('XObject')));
    if (xobjs instanceof PDFDict) {
      for (const [k, v] of xobjs.entries()) {
        const s = doc.context.lookup(v);
        if (s instanceof PDFRawStream) {
          addStream(`${where}/XObject${k}`, s);
          walkResources(s.dict.get(PDFName.of('Resources')), `${where}/XObject${k}`, depth + 1);
        }
      }
    }
    const pats = doc.context.lookup(res.get(PDFName.of('Pattern')));
    if (pats instanceof PDFDict) {
      for (const [k, v] of pats.entries()) addStream(`${where}/Pattern${k}`, doc.context.lookup(v));
    }
  };
  for (const p1 of affectedPages) {
    const page = doc.getPage(p1 - 1);
    const contents = doc.context.lookup(page.node.get(PDFName.of('Contents')) as import('pdf-lib').PDFObject);
    if (contents instanceof PDFRawStream) addStream(`p${p1}/Contents`, contents);
    else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        addStream(`p${p1}/Contents[${i}]`, doc.context.lookup(contents.get(i)));
      }
    }
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i += 1) {
        const a = doc.context.lookup(annots.get(i));
        if (!(a instanceof PDFDict)) continue;
        addText(`p${p1}/Annots[${i}]/Contents`, redactDecodeString(a.get(PDFName.of('Contents'))));
        const ap = doc.context.lookup(a.get(PDFName.of('AP')));
        if (ap instanceof PDFDict) {
          for (const key of ['N', 'D', 'R'] as const) {
            addStream(`p${p1}/Annots[${i}]/AP/${key}`, doc.context.lookup(ap.get(PDFName.of(key))));
          }
        }
      }
    }
    walkResources(page.node.get(PDFName.of('Resources')), `p${p1}`, 0);
  }
  // doc-level scrub targets (the other half of the scope, finding 4)
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const [k, v] of info.entries()) {
      addText(`Info/${k}`, redactDecodeString(v));
    }
  }
  addStream('Metadata', doc.context.lookup(doc.catalog.get(PDFName.of('Metadata'))));
  const outlines = doc.context.lookup(doc.catalog.get(PDFName.of('Outlines')));
  if (outlines instanceof PDFDict) {
    let node = doc.context.lookup(outlines.get(PDFName.of('First')) as import('pdf-lib').PDFObject);
    const seen = new Set<unknown>();
    while (node instanceof PDFDict && !seen.has(node)) {
      seen.add(node);
      addText('Outlines/Title', redactDecodeString(node.get(PDFName.of('Title'))));
      node = doc.context.lookup(node.get(PDFName.of('Next')) as import('pdf-lib').PDFObject);
    }
  }
  const names = doc.context.lookup(doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict) {
    for (const tree of ['JavaScript', 'EmbeddedFiles'] as const) {
      const t = doc.context.lookup(names.get(PDFName.of(tree)));
      const arr = t instanceof PDFDict ? doc.context.lookup(t.get(PDFName.of('Names'))) : null;
      if (!(arr instanceof PDFArray)) continue;
      for (let i = 0; i < arr.size(); i += 2) {
        addText(`Names/${tree}[${i}]`, redactDecodeString(arr.get(i)));
        const val = doc.context.lookup(arr.get(i + 1));
        if (val instanceof PDFDict) {
          addText(`Names/${tree}[${i}]/JS`, redactDecodeString(val.get(PDFName.of('JS'))));
          addText(`Names/${tree}[${i}]/F`, redactDecodeString(val.get(PDFName.of('F'))));
          addText(`Names/${tree}[${i}]/UF`, redactDecodeString(val.get(PDFName.of('UF'))));
          const ef = doc.context.lookup(val.get(PDFName.of('EF')));
          if (ef instanceof PDFDict) {
            for (const key of ['F', 'UF'] as const) {
              addStream(`Names/${tree}[${i}]/EF/${key}`, doc.context.lookup(ef.get(PDFName.of(key))));
            }
          }
        }
      }
    }
  }
  const acro = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  if (acro instanceof PDFDict) {
    const fields = doc.context.lookup(acro.get(PDFName.of('Fields')));
    const walkField = (d: unknown, where: string, depth: number): void => {
      if (!(d instanceof PDFDict) || depth > 8) return;
      for (const key of ['V', 'DV'] as const) {
        addText(`${where}/${key}`, redactDecodeString(d.get(PDFName.of(key))));
      }
      const kids = doc.context.lookup(d.get(PDFName.of('Kids')));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i += 1) {
          walkField(doc.context.lookup(kids.get(i)), `${where}/Kids[${i}]`, depth + 1);
        }
      }
    };
    if (fields instanceof PDFArray) {
      for (let i = 0; i < fields.size(); i += 1) walkField(doc.context.lookup(fields.get(i)), `AcroForm[${i}]`, 0);
    }
  }
  const st = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot')));
  if (st instanceof PDFDict) {
    const walkStruct = (d: unknown, where: string, depth: number): void => {
      if (!(d instanceof PDFDict) || depth > 10) return;
      for (const key of ['Alt', 'ActualText'] as const) {
        addText(`${where}/${key}`, redactDecodeString(d.get(PDFName.of(key))));
      }
      const kids = doc.context.lookup(d.get(PDFName.of('K')));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i += 1) walkStruct(doc.context.lookup(kids.get(i)), `${where}/K[${i}]`, depth + 1);
      } else walkStruct(kids, `${where}/K`, depth + 1);
    };
    walkStruct(st, 'StructTreeRoot', 0);
  }
  return blobs;
}

// ─────────────────────────── composed finalize ───────────────────────────

export interface RedactFinalizeSpec {
  /** Text being redacted (drives the byte-scan + scrub-on-match). */
  secrets: string[];
  /** Surgical rect marks (visual space). Pages must be census-clean. */
  surgical?: RedactSurgicalPage[];
  /** Pre-rendered raster JPEGs with the rects ALREADY PAINTED (finding 1). */
  raster?: { page: number; jpeg: Uint8Array }[];
  /** Doc channels to LEAVE untouched (surfaced in the UI, finding 2). */
  scrubSkip?: string[];
}

export interface RedactFinalizeResult {
  bytes: Uint8Array;
  removedBlocks: number;
  retiredImages: number;
  annots: { page: number; dropped: number; fields: string[] }[];
  scrubActions: RedactScrubAction[];
  rasterPages: number[];
  surgicalPages: number[];
}

/**
 * THE deliver-capable redact op (finding 5). Order (researcher §Q2):
 * refuse-checks → surgical removal → image retirement → annot disposition →
 * doc scrub → raster replacement → pdf-lib full rewrite → INTERNAL qpdf
 * rewrite (orphan GC — the orphan rule) → scoped decompressed byte-scan.
 * Any verify failure discards the output (typed error); nothing partial is
 * ever returned.
 */
export async function redactFinalize(
  bytes: Uint8Array,
  spec: RedactFinalizeSpec,
): Promise<RedactFinalizeResult> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument, PDFName, PDFDict } = pdfLib;
  const secrets = spec.secrets.map((s) => s.trim()).filter((s) => s.length > 0);
  if (secrets.length === 0) throw new RedactRefusedError('No redaction marks were provided.');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageCount = doc.getPageCount();
  const clamp = (p: number): number | null => (Number.isInteger(p) && p >= 1 && p <= pageCount ? p : null);

  const surgical = (spec.surgical ?? []).filter((s) => clamp(s.page) !== null);
  const raster = (spec.raster ?? []).filter((r) => clamp(r.page) !== null);
  const rasterPages = new Set(raster.map((r) => r.page));
  const surgicalScope = new Map<number, RedactRect[]>(); // 0-based
  for (const s of surgical) {
    const p1 = s.page;
    if (rasterPages.has(p1)) continue; // raster wins for the page
    if (!s.rects.length) continue;
    const existing = surgicalScope.get(p1 - 1) ?? [];
    existing.push(...s.rects);
    surgicalScope.set(p1 - 1, existing);
  }

  // refuse-checks BEFORE any mutation
  for (const page of doc.getPages()) {
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    if (!(res instanceof PDFDict)) continue;
    const fonts = doc.context.lookup(res.get(PDFName.of('Font')));
    if (!(fonts instanceof PDFDict)) continue;
    for (const [, v] of fonts.entries()) {
      const fd = doc.context.lookup(v);
      if (fd instanceof PDFDict && String(fd.get(PDFName.of('Wmode')) ?? '') === '/1') {
        throw new RedactRefusedError('Vertical text runs are not supported by redaction.');
      }
    }
  }
  if (docHasDigitalSignature(doc)) {
    throw new RedactRefusedError('The document carries a digital signature; redaction would invalidate it.');
  }

  // census gate: a surgical page carrying escalate-tier constructs must ride
  // the raster path instead (finding 7)
  const census = await redactCensus(bytes);
  const flaggedPages = new Set(census.pages.map((p) => p.page));
  for (const p1 of surgicalScope.keys()) {
    if (flaggedPages.has(p1 + 1) && !rasterPages.has(p1 + 1)) {
      throw new RedactRefusedError(
        `Page ${p1 + 1} carries constructs that force rasterization (census: ${census.pages
          .find((p) => p.page === p1 + 1)!
          .kinds.join(', ')}); supply a raster page for it.`,
      );
    }
  }

  // 1. surgical
  const outcome = redactSurgicalRemove(doc, surgicalScope);
  if (outcome.refusedPages.length > 0) {
    const list = outcome.refusedPages.map((i) => i + 1).join(', ');
    throw new RedactRefusedError(
      `Pages ${list} only partially cover their text with marks — expand the marks or rasterize those pages.`,
    );
  }

  // 2. image retirement + 3. annots (surgical pages; raster pages drop all below)
  const retiredImages = redactRetireImages(doc, surgicalScope);
  const annots = redactDisposeAnnots(doc, surgicalScope);

  // 4. doc scrub
  const skip = new Set(spec.scrubSkip ?? []);
  const scrubActions = redactScrubDocChannels(doc, secrets, skip);

  // 5. raster replacement
  for (const r of raster) {
    await redactReplacePageWithRaster(doc, doc.getPage(r.page - 1), r.jpeg);
  }

  // 6. full rewrite (never incremental) → 7. internal qpdf orphan-GC rewrite
  const rewritten = await doc.save({ useObjectStreams: false });
  let gc: Uint8Array;
  try {
    gc = await qpdfRewrite(rewritten);
  } catch (e) {
    if (e instanceof QpdfRewriteRefusedError) {
      throw new RedactRefusedError('The file cannot be safely rewritten (qpdf refused).');
    }
    throw e;
  }

  // 8. scoped decompressed byte-scan — fail closed, discard everything
  const canon = await qpdfCanonicalUncompress(gc);
  const canonDoc = await PDFDocument.load(canon, { ignoreEncryption: true });
  const affectedPages = [...new Set([...surgicalScope.keys()].map((i) => i + 1).concat([...rasterPages]))].sort((a, b) => a - b);
  const blobs = await redactCollectScopedBlobs(canonDoc, affectedPages);
  const needles = redactNeedles(secrets);
  for (const blob of blobs) {
    for (const nd of needles) {
      if (nd.bytes.length > 0 && indexOfBytes(blob.bytes, nd.bytes) >= 0) {
        throw new RedactVerifyError(
          `Residue found (${nd.enc}) in ${blob.where} — output discarded.`,
        );
      }
    }
  }

  return {
    bytes: gc,
    removedBlocks: outcome.removedBlocks,
    retiredImages,
    annots,
    scrubActions,
    rasterPages: [...rasterPages].sort((a, b) => a - b),
    surgicalPages: [...surgicalScope.keys()].map((i) => i + 1).sort((a, b) => a - b),
  };
}

/** Uint8Array index-of (Buffer-free so the code runs in browser workers too). */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ─────────────────────────── raster clamp (finding 10) ───────────────────────────

/** Max rasterized long edge px (researcher's conservative ceiling 4096). */
export const REDACT_RASTER_MAX_LONG_EDGE = 4096;
/** iOS-safe total pixel budget for one rendered page. */
export const REDACT_RASTER_MAX_PIXELS = 4096 * 4096;

/**
 * EXPLICIT render clamp (finding 10: there is NO pdf.js maxCanvasPixels
 * default on the renderPageToCanvas path — the cap lives in the viewer
 * layer, so the wrapper must clamp here): `min(dpi/72, longEdgeCap / max(w,h),
 * sqrt(pixelBudget / (w*h)))`.
 */
export function redactRasterScale(visualWidth: number, visualHeight: number, dpi = 150): number {
  const byDpi = dpi / 72;
  const byLongEdge = REDACT_RASTER_MAX_LONG_EDGE / Math.max(visualWidth, visualHeight);
  const byPixels = Math.sqrt(REDACT_RASTER_MAX_PIXELS / (visualWidth * visualHeight));
  return Math.max(0.1, Math.min(byDpi, byLongEdge, byPixels));
}

// ───────────────────────── Annotate engine (v0.9.0 phase 4) ─────────────────────────

export type AnnotateElementKind = 'text' | 'rect' | 'line' | 'ellipse';

/**
 * One annotation element, in VISUAL space (origin bottom-left of the
 * displayed page box, y up — the RedactRect convention) so placement is
 * /Rotate- and CropBox-independent. Drawn as CONTENT-STREAM operations (the
 * watermark path — viewer-proof, no /AP machinery; researcher §Q4).
 */
export interface AnnotateElement {
  kind: AnnotateElementKind;
  /** 1-based page. */
  page: number;
  /** Bounding box in visual space. Line = diagonal of the box (TL → BR). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise visual rotation (text only). */
  rotation?: number;
  /** '#rrggbb'; default near-black. */
  color?: string;
  /** 0..1, default 1. */
  opacity?: number;
  /** Text font size / shape stroke width, pt (default 14 / 2). */
  size?: number;
  /** Text content (text kind, required non-empty there). */
  text?: string;
  /** Shapes: filled vs outline (default filled for rect/ellipse). */
  fill?: boolean;
}

/** Refusal before any output: encrypted input, empty/invalid elements, or a
 * text stamp that cannot fit the visible page. */
export class AnnotationRefusedError extends Error {
  constructor(message = 'The annotation cannot be applied.') {
    super(message);
    this.name = 'AnnotationRefusedError';
  }
}

function annotColor(hex: string | undefined): import('pdf-lib').RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return rgb(0.07, 0.07, 0.07);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** True when the document's AcroForm carries a signature field with a
 * ByteRange (/FT /Sig + /V /ByteRange, depth <= 8) — a full pdf-lib rewrite
 * invalidates such signatures, so every mutating op refuses up front
 * (review decision 2026-10-27: one posture with redactFinalize). */
function docHasDigitalSignature(doc: import('pdf-lib').PDFDocument): boolean {
  const acro = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  if (!(acro instanceof PDFDict)) return false;
  const fields = doc.context.lookup(acro.get(PDFName.of('Fields')));
  if (!(fields instanceof PDFArray)) return false;
  const walkSig = (d: unknown, depth: number): boolean => {
    if (!(d instanceof PDFDict) || depth > 8) return false;
    if (String(d.get(PDFName.of('FT')) ?? '') === '/Sig') {
      const v = doc.context.lookup(d.get(PDFName.of('V')));
      if (v instanceof PDFDict && v.get(PDFName.of('ByteRange'))) return true;
    }
    const kids = doc.context.lookup(d.get(PDFName.of('Kids')));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i += 1) {
        if (walkSig(doc.context.lookup(kids.get(i)), depth + 1)) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < fields.size(); i += 1) {
    if (walkSig(doc.context.lookup(fields.get(i)), 0)) return true;
  }
  return false;
}

/** Validation + the per-page draw loop of the composed applyAnnotate op
 * (ONE loaded document, ONE save). */
function stampElementsOnDoc(
  doc: PDFDocument,
  elements: AnnotateElement[],
  font: import('pdf-lib').PDFFont,
): void {
  if (elements.length === 0) {
    throw new AnnotationRefusedError('No annotation elements were provided.');
  }
  const pageCount = doc.getPageCount();
  const byPage = new Map<number, AnnotateElement[]>();
  for (const el of elements) {
    if (
      !Number.isFinite(el.x) || !Number.isFinite(el.y) ||
      !Number.isFinite(el.w) || !Number.isFinite(el.h)
    ) {
      throw new AnnotationRefusedError('An element has non-finite geometry.');
    }
    if (el.kind === 'text' && !(el.text ?? '').trim()) {
      throw new AnnotationRefusedError('A text element has no content.');
    }
    if (el.page < 1 || el.page > pageCount) continue; // stale element, dropped
    const list = byPage.get(el.page) ?? [];
    list.push(el);
    byPage.set(el.page, list);
  }

  for (const [p1, els] of byPage) {
    const page = doc.getPage(p1 - 1);
    const geom = visibleGeometry(page);
    for (const el of els) {
      const color = annotColor(el.color);
      const opacity = Math.min(1, Math.max(0, el.opacity ?? 1));
      const stroke = Math.max(0.5, el.size ?? 2);
      const fill = el.fill ?? (el.kind !== 'line' && el.kind !== 'text');
      if (el.kind === 'text') {
        const size = Math.max(4, el.size ?? 14);
        const text = (el.text ?? '').replace(/\r\n?/g, '\n');
        const width = font.widthOfTextAtSize(text, size);
        // Overflow refuses BEFORE any page is mutated (fail-closed posture).
        if (
          el.x < -1 || el.y < -1 ||
          el.x + width > geom.visualWidth + 1 ||
          el.y + size > geom.visualHeight + 1
        ) {
          throw new AnnotationRefusedError(
            `Text does not fit the visible page ${p1} (needs ${Math.ceil(width)}pt of ${Math.floor(geom.visualWidth)}pt).`,
          );
        }
        const user = visualToPageSpace(el.x, el.y, geom);
        page.drawText(text, {
          x: user.x,
          y: user.y,
          font,
          size,
          rotate: degrees(drawAngleFor(el.rotation ?? 0, geom.rotate)),
          opacity,
          color,
        });
      } else if (el.kind === 'rect') {
        // Anchor = visual bottom-left; the drawAngleFor(·, /Rotate) rotation
        // about that anchor maps the w×h rect back onto the visual box
        // (same proof as the watermark text path; property-matrix tested).
        const p0 = visualToPageSpace(el.x, el.y, geom);
        page.drawRectangle({
          x: p0.x,
          y: p0.y,
          width: Math.max(1, el.w),
          height: Math.max(1, el.h),
          rotate: degrees(drawAngleFor(0, geom.rotate)),
          color: fill ? color : undefined,
          opacity: fill ? opacity : undefined,
          borderColor: fill ? undefined : color,
          borderOpacity: fill ? undefined : opacity,
          borderWidth: fill ? 0 : stroke,
        });
      } else if (el.kind === 'ellipse') {
        // pdf-lib takes the CENTER + radii; a visual-axis-aligned ellipse is
        // user-space-axis-aligned with radii SWAPPED for /Rotate 90|270.
        const c = visualToPageSpace(el.x + el.w / 2, el.y + el.h / 2, geom);
        const swapAxes = geom.rotate === 90 || geom.rotate === 270;
        page.drawEllipse({
          x: c.x,
          y: c.y,
          xScale: Math.max(0.5, (swapAxes ? el.h : el.w) / 2),
          yScale: Math.max(0.5, (swapAxes ? el.w : el.h) / 2),
          color: fill ? color : undefined,
          opacity: fill ? opacity : undefined,
          borderColor: fill ? undefined : color,
          borderOpacity: fill ? undefined : opacity,
          borderWidth: fill ? 0 : stroke,
        });
      } else {
        // Line = the box diagonal, top-left → bottom-right (the natural
        // drag gesture on screen).
        const a = visualToPageSpace(el.x, el.y + el.h, geom);
        const b = visualToPageSpace(el.x + el.w, el.y, geom);
        page.drawLine({
          start: { x: a.x, y: a.y },
          end: { x: b.x, y: b.y },
          thickness: stroke,
          opacity,
          color,
        });
      }
    }
  }
}


// ───────────────── Annotate M2: real annotations + /AP (v0.9.0 phase 5) ─────────────────

export interface HighlightAnnot {
  kind: 'highlight';
  page: number;
  /** Visual-space rects over the highlighted text — one per text line. */
  quads: RedactRect[];
  /** Default classic yellow #ffeb3b. */
  color?: string;
  /** Default 0.4. */
  opacity?: number;
}

export interface NoteAnnot {
  kind: 'note';
  page: number;
  /** Visual-space box; the bottom edge is the text baseline. */
  rect: RedactRect;
  text: string;
  /** Note fill (default pale yellow #fff9c4). */
  color?: string;
  /** Default 12. */
  fontSize?: number;
}

export type PdfAnnot = HighlightAnnot | NoteAnnot;

export interface ApplyAnnotateOptions {
  /** Phase-4 content-stream stamps/shapes. */
  stamps?: AnnotateElement[];
  /** Real PDF annotations (/Highlight, /FreeText) with hand-built /AP. */
  annots?: PdfAnnot[];
}

function annotRgb(hex: string | undefined, fb: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return fb;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Missing-glyph check BEFORE any mutation (PDFCraft refusal precedent): a
 * character the Roboto subset cannot draw refuses the WHOLE apply. */
function assertDrawable(font: import('pdf-lib').PDFFont, text: string): void {
  // embedder is private in pdf-lib's typings but the fontkit font lives at
  // embedder.font (subset embedders only — standard fonts have none).
  const fk = (font as unknown as {
    embedder?: { font?: { layout(t: string): { glyphs: { id: number }[] } } };
    font?: { layout(t: string): { glyphs: { id: number }[] } };
  }).embedder?.font;
  if (!fk) return; // standard font — assume drawable
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === ' ') continue;
    try {
      const { glyphs } = fk.layout(ch);
      if (glyphs.length === 0 || glyphs.every((g) => g.id === 0)) {
        throw new Error('missing glyph');
      }
    } catch {
      throw new AnnotationRefusedError(
        `Undrawable character in note text: ${JSON.stringify(ch)}`,
      );
    }
  }
}

/** Isometry basis: the visual x/y unit axes in user space (the AP text
 * matrix for any /Rotate — never per-rotation case math). */
function visualBasis(geom: PageGeometry): {
  xdir: { x: number; y: number };
  ydir: { x: number; y: number };
  origin: { x: number; y: number };
} {
  const origin = visualToPageSpace(0, 0, geom);
  const ux = visualToPageSpace(1, 0, geom);
  const uy = visualToPageSpace(0, 1, geom);
  return {
    xdir: { x: ux.x - origin.x, y: ux.y - origin.y },
    ydir: { x: uy.x - origin.x, y: uy.y - origin.y },
    origin,
  };
}

function pdfDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * The COMPOSED annotate op (red-team mandate: stamps + annotations ride ONE
 * loaded PDFDocument and ONE save — under the no-auto-retry crash rule a
 * mid-apply crash rejects the whole call, so a retry restarts from the
 * ORIGINAL bytes and can never double-stamp). Refusals (encrypted input,
 * undrawable characters, invalid geometry) happen BEFORE any mutation and
 * leave the input untouched.
 */
export async function applyAnnotate(
  bytes: Uint8Array,
  opts: ApplyAnnotateOptions,
  fontTtf: Uint8Array,
): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFHexString, PDFString } = pdfLib;
  let doc: import('pdf-lib').PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (e) {
    throw new AnnotationRefusedError(
      `The file cannot be annotated (encrypted or unreadable): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (docHasDigitalSignature(doc)) {
    throw new AnnotationRefusedError(
      'The document carries a digital signature; annotating would invalidate it.',
    );
  }
  const stamps = opts.stamps ?? [];
  const annots = opts.annots ?? [];
  if (stamps.length === 0 && annots.length === 0) {
    throw new AnnotationRefusedError('Nothing to apply was provided.');
  }
  const font = await embedRobotoSubset(doc, fontTtf);
  const pageCount = doc.getPageCount();
  // Pre-checks BEFORE any mutation (fail closed, nothing half-applied).
  for (const a of annots) {
    if (a.page < 1 || a.page > pageCount) {
      throw new AnnotationRefusedError(`Annotation page ${a.page} is out of range.`);
    }
    if (a.kind === 'note') {
      if (!a.text.trim()) throw new AnnotationRefusedError('A note has no text.');
      assertDrawable(font, a.text);
    } else if (a.quads.length === 0) {
      throw new AnnotationRefusedError('A highlight has no quads.');
    }
  }
  if (stamps.length > 0) stampElementsOnDoc(doc, stamps, font);

  const now = pdfDate();
  for (const a of annots) {
    const page = doc.getPage(a.page - 1);
    const geom = visibleGeometry(page);
    const node = page.node;

    if (a.kind === 'highlight') {
      const [r, g, b] = annotRgb(a.color, [1, 0.92, 0.23]);
      const alpha = Math.min(1, Math.max(0.05, a.opacity ?? 0.4));
      // Map every quad corner to user space; QuadPoints order per spec:
      // TL, TR, BL, BR of each quad.
      const corners = a.quads.map((q) => ({
        tl: visualToPageSpace(q.x, q.y + q.h, geom),
        tr: visualToPageSpace(q.x + q.w, q.y + q.h, geom),
        bl: visualToPageSpace(q.x, q.y, geom),
        br: visualToPageSpace(q.x + q.w, q.y, geom),
      }));
      const xs = corners.flatMap((c) => [c.tl.x, c.tr.x, c.bl.x, c.br.x]);
      const ys = corners.flatMap((c) => [c.tl.y, c.tr.y, c.bl.y, c.br.y]);
      const x0 = Math.min(...xs) - 2;
      const y0 = Math.min(...ys) - 2;
      const x1 = Math.max(...xs) + 2;
      const y1 = Math.max(...ys) + 2;
      // AP content: one filled path per quad, in user space via the
      // translate matrix (the viewer applies /CA when compositing).
      let content = `q ${r} ${g} ${b} rg\n`;
      for (const c of corners) {
        content += `${c.tl.x} ${c.tl.y} m ${c.tr.x} ${c.tr.y} l ${c.br.x} ${c.br.y} l ${c.bl.x} ${c.bl.y} l h f\n`;
      }
      content += 'Q';
      const apDict = PDFDict.withContext(doc.context);
      apDict.set(PDFName.of('Type'), PDFName.of('XObject'));
      apDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
      apDict.set(PDFName.of('BBox'), doc.context.obj([PDFNumber.of(x0), PDFNumber.of(y0), PDFNumber.of(x1), PDFNumber.of(y1)]));
      apDict.set(PDFName.of('Matrix'), doc.context.obj([PDFNumber.of(1), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1), PDFNumber.of(-x0), PDFNumber.of(-y0)]));
      const apRef = doc.context.register(PDFRawStream.of(apDict, new TextEncoder().encode(content)));

      const quads = PDFArray.withContext(doc.context);
      for (const c of corners) {
        for (const pt of [c.tl, c.tr, c.bl, c.br]) {
          quads.push(PDFNumber.of(pt.x));
          quads.push(PDFNumber.of(pt.y));
        }
      }
      const dict = PDFDict.withContext(doc.context);
      dict.set(PDFName.of('Type'), PDFName.of('Annot'));
      dict.set(PDFName.of('Subtype'), PDFName.of('Highlight'));
      dict.set(PDFName.of('Rect'), doc.context.obj([PDFNumber.of(x0), PDFNumber.of(y0), PDFNumber.of(x1), PDFNumber.of(y1)]));
      dict.set(PDFName.of('QuadPoints'), quads);
      dict.set(PDFName.of('F'), PDFNumber.of(4));
      dict.set(PDFName.of('M'), PDFString.of(now));
      dict.set(PDFName.of('C'), doc.context.obj([PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)]));
      dict.set(PDFName.of('IC'), doc.context.obj([PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)]));
      dict.set(PDFName.of('CA'), PDFNumber.of(alpha));
      dict.set(PDFName.of('Border'), doc.context.obj([PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0)]));
      const apN = PDFDict.withContext(doc.context);
      apN.set(PDFName.of('N'), apRef);
      dict.set(PDFName.of('AP'), apN);
      addAnnotToPage(doc, node, dict);
    } else {
      // FreeText note: visible box with a Roboto /AP (portable rendering —
      // without /AP FreeText is viewer-dependent; annotpdf 1.0.15 added AP
      // generation for exactly this reason).
      const [r, g, b] = annotRgb(a.color, [1, 0.976, 0.769]);
      const size = Math.max(6, a.fontSize ?? 12);
      const basis = visualBasis(geom);
      const rectBL = visualToPageSpace(a.rect.x, a.rect.y, geom);
      const rectTR = visualToPageSpace(a.rect.x + a.rect.w, a.rect.y + a.rect.h, geom);
      const x0 = Math.min(rectBL.x, rectTR.x) - 1;
      const y0 = Math.min(rectBL.y, rectTR.y) - 1;
      const x1 = Math.max(rectBL.x, rectTR.x) + 1;
      const y1 = Math.max(rectBL.y, rectTR.y) + 1;
      // Note box as an explicit quad path (axis-aligned in VISUAL space).
      const cTL = visualToPageSpace(a.rect.x, a.rect.y + a.rect.h, geom);
      const cTR = visualToPageSpace(a.rect.x + a.rect.w, a.rect.y + a.rect.h, geom);
      const cBL = rectBL;
      const cBR = visualToPageSpace(a.rect.x + a.rect.w, a.rect.y, geom);
      const textHex = font.encodeText(a.text.replace(/\r\n?/g, '\n'));
      const dark = 0.1;
      const content = [
        `q ${r} ${g} ${b} rg`,
        `${cTL.x} ${cTL.y} m ${cTR.x} ${cTR.y} l ${cBR.x} ${cBR.y} l ${cBL.x} ${cBL.y} l h f`,
        'Q',
        `BT ${dark} ${dark} ${dark} rg /F0 ${size} Tf`,
        `${basis.xdir.x} ${basis.xdir.y} ${basis.ydir.x} ${basis.ydir.y} ${rectBL.x + 2} ${rectBL.y + 2} Tm`,
        `${textHex.toString()} Tj`,
        'ET',
      ].join('\n');
      const apDict = PDFDict.withContext(doc.context);
      apDict.set(PDFName.of('Type'), PDFName.of('XObject'));
      apDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
      apDict.set(PDFName.of('BBox'), doc.context.obj([PDFNumber.of(x0), PDFNumber.of(y0), PDFNumber.of(x1), PDFNumber.of(y1)]));
      apDict.set(PDFName.of('Matrix'), doc.context.obj([PDFNumber.of(1), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1), PDFNumber.of(-x0), PDFNumber.of(-y0)]));
      // By REF, never context.lookup: subset-font dicts materialize only
      // during save's embedAll (embedFont takes the ref upfront), so a
      // pre-save lookup is always undefined.
      const fontRes = PDFDict.withContext(doc.context);
      fontRes.set(PDFName.of('F0'), font.ref);
      const res = PDFDict.withContext(doc.context);
      res.set(PDFName.of('Font'), fontRes);
      apDict.set(PDFName.of('Resources'), res);
      const apRef = doc.context.register(PDFRawStream.of(apDict, new TextEncoder().encode(content)));

      const dict = PDFDict.withContext(doc.context);
      dict.set(PDFName.of('Type'), PDFName.of('Annot'));
      dict.set(PDFName.of('Subtype'), PDFName.of('FreeText'));
      dict.set(PDFName.of('Rect'), doc.context.obj([PDFNumber.of(x0), PDFNumber.of(y0), PDFNumber.of(x1), PDFNumber.of(y1)]));
      dict.set(PDFName.of('F'), PDFNumber.of(4));
      dict.set(PDFName.of('M'), PDFString.of(now));
      dict.set(PDFName.of('Contents'), PDFHexString.fromText(a.text));
      dict.set(PDFName.of('DA'), PDFString.of('(Helv 0 Tf 0 g)'));
      dict.set(PDFName.of('C'), doc.context.obj([PDFNumber.of(1), PDFNumber.of(1), PDFNumber.of(0.6)]));
      const apN2 = PDFDict.withContext(doc.context);
      apN2.set(PDFName.of('N'), apRef);
      dict.set(PDFName.of('AP'), apN2);
      addAnnotToPage(doc, node, dict);
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** Appends an annotation dict (indirect) to the page's /Annots array. */
function addAnnotToPage(
  doc: import('pdf-lib').PDFDocument,
  node: import('pdf-lib').PDFPageLeaf,
  dict: import('pdf-lib').PDFDict,
): void {
  const { PDFArray, PDFName } = pdfLibCache!;
  const ref = doc.context.register(dict);
  const existing = doc.context.lookup(node.get(PDFName.of('Annots')));
  if (existing instanceof PDFArray) {
    existing.push(ref);
  } else {
    const arr = PDFArray.withContext(doc.context);
    arr.push(ref);
    node.set(PDFName.of('Annots'), arr);
  }
}

// ---- Text edit M3a: white-out + re-typeset (v0.9.0 phase 6) — append-only
// R1's shippable subset (plan phase-06): remove a selected run via the
// phase-2 surgical machinery, cover with white, draw the replacement at the
// run's baseline with the in-tree Roboto (REAL text — stays searchable).
// The original font is NOT preserved (M3b same-font re-encoding is an
// explicit stretch; subset GID remapping is font-compiler territory).
//
// Soundness rests on the CENSUS GATE: an edited page carries none of the
// escalate-tier constructs (Type3, no-ToUnicode, ActualText, Tr3, patterns,
// text XObjects, OC layers, widget/hidden annots), so the run's text lives
// ONLY in the page content streams. Residue scan is therefore scoped to the
// edited pages' NON-content reachable objects (ToUnicode cmaps, XObjects,
// Patterns): a same-page twin of the run text legitimately survives in the
// content stream (finding 13 — editing one of two identical totals is
// VALID), and the replacement may CONTAIN the old text ("100" → "1000").
// Both would false-positive a content-stream scan; the surviving-twin
// guarantee comes from the run-scoped semantic leg (edit-text-pipeline),
// never from a page-wide byte scan. NO rasterize recovery exists in this
// op: any verify failure is a typed refusal, input untouched.

export class EditTextRefusedError extends Error {
  constructor(message = 'The text edit was refused; the input is untouched.') {
    super(message);
    this.name = 'EditTextRefusedError';
  }
}

export class EditTextVerifyError extends Error {
  constructor(message = 'The edited output failed verification; nothing was delivered.') {
    super(message);
    this.name = 'EditTextVerifyError';
  }
}

export interface EditTextRun {
  /** 1-based page. */
  page: number;
  /** Run box in VISUAL space (bottom-left origin, y up). */
  rect: RedactRect;
  /** Baseline y in VISUAL space (pdf.js item transform). */
  baselineY: number;
  /** The run's text as extracted client-side (needle source). */
  text: string;
  /** Replacement text ('' = pure white-out). Single line only. */
  replacement: string;
  /** Allowed overflow over the run width, fraction (default 0.25). */
  tolerance?: number;
  /** Replacement size hint (pt); default derived from the rect height. */
  fontSize?: number;
}

export interface EditTextRunsSpec {
  runs: EditTextRun[];
}

export interface EditTextRunsResult {
  bytes: Uint8Array;
  removedBlocks: number;
  edits: { page: number; text: string; replacement: string; fittedSize: number }[];
}

/** Non-content reachable objects of the affected pages: ToUnicode cmaps,
 * XObjects (recursive), Patterns — the residue scan scope for edits. */
function editCollectScopedBlobs(
  doc: PDFDocument,
  affectedPages: number[], // 1-based
): { where: string; bytes: Uint8Array }[] {
  const { PDFName, PDFDict, PDFRawStream } = pdfLibCache!;
  const blobs: { where: string; bytes: Uint8Array }[] = [];
  const addStream = (where: string, s: unknown): void => {
    if (!(s instanceof PDFRawStream)) return;
    const text = redactStreamText(s);
    blobs.push({ where, bytes: text === null ? s.contents : latin1ToBytes(text) });
  };
  const walkResources = (resRef: unknown, where: string, depth: number): void => {
    const res = doc.context.lookup(resRef as import('pdf-lib').PDFObject);
    if (!(res instanceof PDFDict) || depth > 5) return;
    const fonts = doc.context.lookup(res.get(PDFName.of('Font')));
    if (fonts instanceof PDFDict) {
      for (const [k, v] of fonts.entries()) {
        const fd = doc.context.lookup(v);
        if (!(fd instanceof PDFDict)) continue;
        addStream(`${where}/Font${k}/ToUnicode`, doc.context.lookup(fd.get(PDFName.of('ToUnicode'))));
      }
    }
    const xobjs = doc.context.lookup(res.get(PDFName.of('XObject')));
    if (xobjs instanceof PDFDict) {
      for (const [k, v] of xobjs.entries()) {
        const xo = doc.context.lookup(v);
        if (xo instanceof PDFRawStream) {
          addStream(`${where}/XObject${k}`, xo);
          walkResources(xo.dict.get(PDFName.of('Resources')), `${where}/XObject${k}`, depth + 1);
        }
      }
    }
    const pats = doc.context.lookup(res.get(PDFName.of('Pattern')));
    if (pats instanceof PDFDict) {
      for (const [k, v] of pats.entries()) addStream(`${where}/Pattern${k}`, doc.context.lookup(v));
    }
  };
  for (const p1 of affectedPages) {
    walkResources(doc.getPage(p1 - 1).node.get(PDFName.of('Resources')), `p${p1}`, 0);
  }
  return blobs;
}

/**
 * M3a: for each run — remove its BT..ET block(s) via the phase-2 surgical
 * machinery (every show op in a removed block must fall inside the run's
 * rect; anything partial refuses the WHOLE apply), draw a white cover and
 * the replacement at the run's baseline (Roboto, fontkit-measured,
 * shrink-to-fit within tolerance), full rewrite → internal qpdf rewrite →
 * scoped decompressed residue scan (non-content objects; see the section
 * note). Refusals and verify failures happen with the INPUT untouched.
 */
export async function editTextRuns(
  bytes: Uint8Array,
  spec: EditTextRunsSpec,
  fontTtf: Uint8Array,
): Promise<EditTextRunsResult> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument, degrees, rgb } = pdfLib;
  const runs = spec.runs;
  if (runs.length === 0) throw new EditTextRefusedError('No text edits were provided.');
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (e) {
    throw new EditTextRefusedError(
      `The file cannot be edited (encrypted or unreadable): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (docHasDigitalSignature(doc)) {
    throw new EditTextRefusedError(
      'The document carries a digital signature; editing would invalidate it.',
    );
  }
  const pageCount = doc.getPageCount();

  // Pre-checks BEFORE any mutation.
  for (const run of runs) {
    if (!(Number.isInteger(run.page) && run.page >= 1 && run.page <= pageCount)) {
      throw new EditTextRefusedError(`Edit page ${run.page} is out of range.`);
    }
    if (!run.text.trim()) throw new EditTextRefusedError('An edit has no original text.');
    if (run.replacement.includes('\n') || run.replacement.includes('\r')) {
      throw new EditTextRefusedError('Replacement text must be a single line.');
    }
  }
  // Census gate: flagged pages force refusal (no raster tier for edits —
  // the honest subset; a flagged page's text may hide in constructs the
  // walker cannot see).
  const census = await redactCensus(bytes);
  const flagged = new Map(census.pages.map((p) => [p.page, p.kinds]));
  for (const run of runs) {
    const kinds = flagged.get(run.page);
    if (kinds) {
      throw new EditTextRefusedError(
        `Page ${run.page} carries constructs text editing cannot see (${kinds.join(', ')}).`,
      );
    }
  }

  const font = await embedRobotoSubset(doc, fontTtf);
  // Fit the replacement into the run box BEFORE mutating anything.
  const fitted: number[] = [];
  for (const run of runs) {
    // Undrawable replacement glyph refuses up front (the notes-path
    // assertDrawable posture) — a missing id would otherwise surface only
    // as a confusing verify error after the rewrite.
    if (run.replacement.length > 0) {
      try {
        assertDrawable(font, run.replacement);
      } catch {
        throw new EditTextRefusedError(
          `Replacement text contains a character the font cannot draw (page ${run.page}, "${run.replacement}").`,
        );
      }
    }
    const tol = Math.max(0, run.tolerance ?? 0.25);
    let size = Math.max(6, run.fontSize ?? run.rect.h * 0.78);
    if (run.replacement.length > 0) {
      for (let i = 0; i < 24 && font.widthOfTextAtSize(run.replacement, size) > run.rect.w * (1 + tol); i += 1) {
        size = Math.max(6, size * 0.9);
        if (size <= 6) break;
      }
      if (font.widthOfTextAtSize(run.replacement, size) > run.rect.w * (1 + tol)) {
        throw new EditTextRefusedError(
          `Replacement does not fit the original run width (page ${run.page}, "${run.replacement}").`,
        );
      }
    }
    fitted.push(size);
  }

  // 1. Removal — the phase-2 machinery, keyed by the runs' rects.
  const scope = new Map<number, RedactRect[]>(); // 0-based page index
  for (const run of runs) {
    const list = scope.get(run.page - 1) ?? [];
    list.push(run.rect);
    scope.set(run.page - 1, list);
  }
  const outcome = redactSurgicalRemove(doc, scope);
  if (outcome.refusedPages.length > 0) {
    throw new EditTextRefusedError(
      `Page(s) ${outcome.refusedPages.map((i) => i + 1).join(', ')} contain text blocks that mix the selection with other content — nothing was applied.`,
    );
  }
  if (outcome.removedBlocks === 0) {
    throw new EditTextRefusedError('None of the selected text could be located in the content stream.');
  }

  // 2. White cover + replacement (geometry primitives only).
  const pages = doc.getPages();
  runs.forEach((run, i) => {
    const page = pages[run.page - 1];
    const geom = visibleGeometry(page);
    const bl = visualToPageSpace(run.rect.x, run.rect.y, geom);
    page.drawRectangle({
      x: bl.x,
      y: bl.y,
      width: run.rect.w,
      height: run.rect.h,
      rotate: degrees(drawAngleFor(0, geom.rotate)),
      color: rgb(1, 1, 1),
      opacity: 1,
    });
    if (run.replacement.length > 0) {
      const base = visualToPageSpace(run.rect.x, run.baselineY, geom);
      page.drawText(run.replacement, {
        x: base.x,
        y: base.y,
        font,
        size: fitted[i]!,
        color: rgb(0.1, 0.1, 0.1),
        rotate: degrees(drawAngleFor(0, geom.rotate)),
      });
    }
  });

  // 3. Full rewrite → internal qpdf rewrite → scoped residue scan.
  const rewritten = await doc.save({ useObjectStreams: false });
  let gc: Uint8Array;
  try {
    gc = await qpdfRewrite(rewritten);
  } catch (e) {
    if (e instanceof QpdfRewriteRefusedError) {
      throw new EditTextRefusedError('The file cannot be safely rewritten (qpdf refused).');
    }
    throw e;
  }
  const canon = await qpdfCanonicalUncompress(gc);
  const canonDoc = await PDFDocument.load(canon, { ignoreEncryption: true });
  const affected = [...new Set(runs.map((r) => r.page))].sort((a, b) => a - b);
  const blobs = editCollectScopedBlobs(canonDoc, affected);
  const needles = redactNeedles(runs.map((r) => r.text));
  for (const blob of blobs) {
    for (const nd of needles) {
      if (nd.bytes.length > 0 && indexOfBytes(blob.bytes, nd.bytes) >= 0) {
        throw new EditTextVerifyError(`Residue found (${nd.enc}) in ${blob.where} — output discarded.`);
      }
    }
  }

  return {
    bytes: gc,
    removedBlocks: outcome.removedBlocks,
    edits: runs.map((r, i) => ({
      page: r.page,
      text: r.text,
      replacement: r.replacement,
      fittedSize: fitted[i]!,
    })),
  };
}

// ---- Crop (v0.9.0 phase 7) — append-only section ---------------------------
// Visual crop = /CropBox manipulation ONLY (MediaBox untouched): content
// outside the box REMAINS in the file — crop is NOT redaction (the UI says
// so and routes destruction intent through src/lib/redact-pipeline.ts).
// All box math goes through the v0.8 geometry primitives (invariant 3).

export class CropRefusedError extends Error {
  constructor(message = 'The crop box was refused; the input is untouched.') {
    super(message);
    this.name = 'CropRefusedError';
  }
}

/** Fractions of the VISIBLE page box (0..1), bottom-left origin y up —
 * resolution-independent, exactly what the overlay drag produces. */
export interface CropFracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropPageBox {
  /** 1-based page. */
  page: number;
  rect: CropFracRect;
}

/**
 * Sets /CropBox per page from visual-space boxes; MediaBox is untouched.
 * Boxes are clamped inside the page's current VISIBLE box (which may itself
 * be a pre-existing CropBox — crop-of-crop narrows it). Degenerate results
 * (≤1pt on an edge after clamping) refuse with the input untouched.
 */
export async function cropPages(
  bytes: Uint8Array,
  boxes: CropPageBox[],
): Promise<Uint8Array> {
  const pdfLib = await import('pdf-lib');
  pdfLibCache = pdfLib;
  const { PDFDocument } = pdfLib;
  if (boxes.length === 0) throw new CropRefusedError('No crop boxes were provided.');
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (e) {
    throw new CropRefusedError(
      `The file cannot be cropped (encrypted or unreadable): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (docHasDigitalSignature(doc)) {
    throw new CropRefusedError(
      'The document carries a digital signature; cropping would invalidate it.',
    );
  }
  const pageCount = doc.getPageCount();

  // Pre-checks BEFORE mutation: sane fractions, valid pages.
  for (const b of boxes) {
    if (!(Number.isInteger(b.page) && b.page >= 1 && b.page <= pageCount)) {
      throw new CropRefusedError(`Crop page ${b.page} is out of range.`);
    }
    const { rect } = b;
    if (!(rect.w > 0 && rect.h > 0)) {
      throw new CropRefusedError(`The crop box on page ${b.page} is empty or inverted.`);
    }
  }

  for (const b of boxes) {
    const page = doc.getPage(b.page - 1);
    const geom = visibleGeometry(page);
    const v0 = { x: b.rect.x * geom.visualWidth, y: b.rect.y * geom.visualHeight };
    const v1 = {
      x: (b.rect.x + b.rect.w) * geom.visualWidth,
      y: (b.rect.y + b.rect.h) * geom.visualHeight,
    };
    // Visual corners → user space; the /Rotate multiple of 90 keeps the
    // mapped box axis-aligned, so bounding the corners is exact.
    const c0 = visualToPageSpace(v0.x, v0.y, geom);
    const c1 = visualToPageSpace(v1.x, v1.y, geom);
    const x0 = Math.min(c0.x, c1.x);
    const x1 = Math.max(c0.x, c1.x);
    const y0 = Math.min(c0.y, c1.y);
    const y1 = Math.max(c0.y, c1.y);
    // Clamp inside the current visible box (crop-of-crop narrows).
    const cx0 = Math.max(geom.x, x0);
    const cy0 = Math.max(geom.y, y0);
    const cx1 = Math.min(geom.x + geom.width, x1);
    const cy1 = Math.min(geom.y + geom.height, y1);
    if (cx1 - cx0 <= 1 || cy1 - cy0 <= 1) {
      throw new CropRefusedError(
        `The crop box on page ${b.page} is degenerate after clamping to the page.`,
      );
    }
    page.setCropBox(cx0, cy0, cx1 - cx0, cy1 - cy0);
  }
  return doc.save({ useObjectStreams: false });
}
