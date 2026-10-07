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
