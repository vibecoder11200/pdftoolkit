import { PDFDocument, degrees, rgb } from 'pdf-lib';

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
