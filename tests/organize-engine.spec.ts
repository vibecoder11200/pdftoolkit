import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFHexString, PDFDict, PDFArray } from 'pdf-lib';
import {
  organizeExport,
  OrganizeUnsupportedError,
} from '../src/engine/pdf-lib';
import { parseOutlines } from '../src/lib/bookmarks';


/** Build a tiny signed-shaped source (/FT /Sig + /V /ByteRange). */
async function signedSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const ctx = doc.context;
  const sigV = ctx.obj({ ByteRange: ctx.obj([0, 100, 200, 50]) });
  const sigVRef = ctx.register(sigV);
  const sigField = ctx.obj({
    FT: PDFName.of('Sig'),
    T: PDFHexString.fromText('Sig1'),
    V: sigVRef,
  });
  const sigRef = ctx.register(sigField);
  const acro = ctx.obj({ Fields: ctx.obj([sigRef]) });
  const acroRef = ctx.register(acro);
  doc.catalog.set(PDFName.of('AcroForm'), acroRef);
  return doc.save({ useObjectStreams: false });
}

/** 3-page source with a text field on p1 + a link p1->p3 + named dest to p2. */
async function richSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([300, 300]);
  const p2 = doc.addPage([300, 300]);
  const p3 = doc.addPage([300, 300]);
  p1.drawText('PAGE ONE', { x: 10, y: 280, size: 12 });
  p2.drawText('PAGE TWO', { x: 10, y: 280, size: 12 });
  p3.drawText('PAGE THREE', { x: 10, y: 280, size: 12 });
  const form = doc.getForm();
  const fld = form.createTextField('addr');
  fld.addToPage(p1);
  fld.setText('Old Street 12');
  const ctx = doc.context;
  // link annot p1 -> p3
  const link = ctx.obj({
    Subtype: PDFName.of('Link'),
    Dest: ctx.obj([p3.ref, PDFName.of('Fit')]),
  });
  const linkRef = ctx.register(link);
  const p1d = ctx.lookup(p1.ref) as PDFDict;
  // APPEND to existing annots (addToPage already placed the widget ref there)
  const existing = ctx.lookup(p1d.get(PDFName.of('Annots')));
  if (existing instanceof PDFArray) existing.push(linkRef);
  else p1d.set(PDFName.of('Annots'), ctx.obj([linkRef]));
  // named dest tree -> p2
  const destArr = ctx.obj([p2.ref, PDFName.of('Fit')]);
  const leaf = ctx.obj({ Names: ctx.obj([PDFHexString.fromText('target-two'), destArr]) });
  const leafRef = ctx.register(leaf);
  const root = ctx.obj({ Kids: ctx.obj([leafRef]) });
  const rootRef = ctx.register(root);
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: rootRef }));
  return doc.save({ useObjectStreams: false });
}

describe('organizeExport — pages, rotation, duplicates', () => {
  it('materializes the plan: reorder + blank + rotation + duplicates', async () => {
    const srcBytes = await richSource();
    const { bytes, report } = await organizeExport(
      [srcBytes],
      [
        { kind: 'source', source: 0, page: 3, rotation: 90 },
        { kind: 'blank', widthPt: 200, heightPt: 400 },
        { kind: 'source', source: 0, page: 1, rotation: 0 },
        { kind: 'source', source: 0, page: 1, rotation: 90 }, // duplicate
      ],
    );
    void report;
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(4);
    expect(out.getPage(0).getSize().width).toBe(300);
    expect(out.getPage(1).getSize()).toEqual(expect.objectContaining({ width: 200, height: 400 }));
    // duplicate copies are independent page objects
    const [p3, p4] = [out.getPage(2), out.getPage(3)];
    expect(p3.ref).not.toBe(p4.ref);
    // rotation applied
    expect(out.getPage(0).getRotation().angle).toBe(90);
    expect(out.getPage(3).getRotation().angle).toBe(90);
    expect(out.getPage(2).getRotation().angle).toBe(0);
  });

  it('empty plan refuses (invalid empty PDF)', async () => {
    await expect(organizeExport([], [])).rejects.toThrow(OrganizeUnsupportedError);
  });
});

describe('organizeExport — RT2 object-integrity matrix', () => {
  it('form field survives export with value + type (reopen via Form)', async () => {
    const srcBytes = await richSource();
    const { bytes } = await organizeExport([srcBytes], [{ kind: 'source', source: 0, page: 1 }]);
    const out = await PDFDocument.load(bytes);
    const form = out.getForm();
    const fld = form.getTextField('addr');
    expect(fld.getText()).toBe('Old Street 12');
  });

  it('field-name collision across sources renames deterministically + reports mapping', async () => {
    const a = await richSource();
    const b = await richSource();
    const { bytes, report } = await organizeExport(
      [a, b],
      [
        { kind: 'source', source: 0, page: 1 },
        { kind: 'source', source: 1, page: 1 },
      ],
    );
    expect(report.fieldRenames['addr']).toBeDefined();
    expect(report.fieldRenames['addr']).toMatch(/^addr#\d+$/);
    const out = await PDFDocument.load(bytes);
    const form = out.getForm();
    expect(form.getTextField('addr').getText()).toBe('Old Street 12');
    const renamed = form.getTextField(report.fieldRenames['addr']!);
    expect(renamed.getText()).toBe('Old Street 12'); // same value, independent identity
  });

  it('duplicate page with the same field: editing the copy cannot mutate the original', async () => {
    const srcBytes = await richSource();
    const { bytes, report } = await organizeExport(
      [srcBytes],
      [
        { kind: 'source', source: 0, page: 1 },
        { kind: 'source', source: 0, page: 1 }, // duplicate
      ],
    );
    expect(Object.keys(report.fieldRenames)).toContain('addr'); // second copy renamed
    const out = await PDFDocument.load(bytes);
    const form = out.getForm();
    form.getTextField('addr').setText('FIRST');
    form.getTextField(report.fieldRenames['addr']!).setText('SECOND');
    expect(form.getTextField('addr').getText()).toBe('FIRST');
    expect(form.getTextField(report.fieldRenames['addr']!).getText()).toBe('SECOND');
  });

  it('local link remaps to the surviving output page (reorder: p3 first)', async () => {
    const srcBytes = await richSource();
    const { bytes, report } = await organizeExport(
      [srcBytes],
      [{ kind: 'source', source: 0, page: 3 }],
    );
    void report;
    const out = await PDFDocument.load(bytes);
    const ctx = out.context;
    const pDict = ctx.lookup(out.getPage(0).ref) as PDFDict;
    const annots = ctx.lookup(pDict.get(PDFName.of('Annots'))) as PDFArray;
    let linkDest: PDFArray | null = null;
    for (let i = 0; i < annots.size(); i += 1) {
      const a = ctx.lookup(annots.get(i));
      if (a instanceof PDFDict && a.has(PDFName.of('Dest'))) {
        linkDest = ctx.lookup(a.get(PDFName.of('Dest'))) as PDFArray;
      }
    }
    // source p3's link pointed back to p1 — p1 not in output -> dropped
    expect(linkDest).toBeNull();
  });

  it('link to an included page lands on the FIRST copy of that page', async () => {
    const srcBytes = await richSource();
    // take p1 (has link -> p3) AND p3; then duplicate p3
    const { bytes, report } = await organizeExport(
      [srcBytes],
      [
        { kind: 'source', source: 0, page: 3 },
        { kind: 'source', source: 0, page: 1 },
        { kind: 'source', source: 0, page: 3 },
      ],
    );
    expect(report.droppedLinks).toBe(0);
    const out = await PDFDocument.load(bytes);
    const ctx = out.context;
    // p1 is output page 2; its link must target output page 1 (first p3 copy)
    const pDict = ctx.lookup(out.getPage(1).ref) as PDFDict;
    const annots = ctx.lookup(pDict.get(PDFName.of('Annots'))) as PDFArray;
    let targetRef: unknown = null;
    for (let i = 0; i < annots.size(); i += 1) {
      const a = ctx.lookup(annots.get(i));
      if (a instanceof PDFDict && a.has(PDFName.of('Dest'))) {
        const d = ctx.lookup(a.get(PDFName.of('Dest'))) as PDFArray;
        targetRef = d.get(0);
      }
    }
    expect(targetRef).toBe(out.getPage(0).ref);
  });
});

describe('organizeExport — named dests, bookmarks, refusals', () => {
  it('named dest remaps to surviving page; missing target reported', async () => {
    const srcBytes = await richSource(); // named 'target-two' -> p2
    const { bytes, report } = await organizeExport(
      [srcBytes],
      [
        { kind: 'source', source: 0, page: 2 },
        { kind: 'source', source: 0, page: 1 },
      ],
    );
    // p2 IS included -> remapped to output page 1
    expect(report.unresolvedDests).toHaveLength(0);
    const out = await PDFDocument.load(bytes);
    const r = await parseOutlines(bytes);
    expect(r.namedDests.get('target-two')?.page).toBe(1);
    void out;
  });

  it('named dest to an excluded page is reported, never stale', async () => {
    const srcBytes = await richSource();
    const { bytes, report } = await organizeExport(
      [srcBytes],
      [{ kind: 'source', source: 0, page: 1 }], // p2 excluded
    );
    expect(report.unresolvedDests).toContain('target-two');
    const out = await PDFDocument.load(bytes);
    expect(out.catalog.get(PDFName.of('Names'))).toBeUndefined();
  });

  it('bookmarks write + parse roundtrip with remapped targets', async () => {
    const srcBytes = await richSource();
    const { bytes, report } = await organizeExport(
      [srcBytes],
      [
        { kind: 'source', source: 0, page: 3 },
        { kind: 'source', source: 0, page: 1 },
      ],
      [
        {
          title: 'Kết',
          destPage: 1,
          view: { kind: 'xyz', x: 0, y: 300, zoom: 1 },
          children: [{ title: 'Mở đầu', destPage: 2, view: { kind: 'fit' } }],
        },
        { title: 'rác', destPage: 9 }, // out of range -> reported
      ],
    );
    expect(report.unresolvedBookmarks).toEqual(['rác']);
    const r = await parseOutlines(bytes);
    expect(r.roots).toHaveLength(2);
    expect(r.roots[0]!.title).toBe('Kết');
    expect(r.roots[0]!.dest!.page).toBe(1);
    expect(r.roots[0]!.dest!.view.kind).toBe('xyz');
    expect(r.roots[0]!.children[0]!.title).toBe('Mở đầu');
    expect(r.roots[0]!.children[0]!.dest!.page).toBe(2);
  });

  it('digitally signed source refuses BEFORE mutation', async () => {
    const signed = await signedSource();
    await expect(
      organizeExport([signed], [{ kind: 'source', source: 0, page: 1 }]),
    ).rejects.toThrow(OrganizeUnsupportedError);
  });

  it('XFA source refuses before mutation', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const ctx = doc.context;
    const acro = ctx.obj({ XFA: ctx.obj([]) });
    const acroRef = ctx.register(acro);
    doc.catalog.set(PDFName.of('AcroForm'), acroRef);
    const xfa = await doc.save();
    await expect(
      organizeExport([xfa], [{ kind: 'source', source: 0, page: 1 }]),
    ).rejects.toThrow(OrganizeUnsupportedError);
  });

  it('roundtrip through pdf.js: page count + text survive', { timeout: 20_000 }, async () => {
    const srcBytes = await richSource();
    const { bytes } = await organizeExport(
      [srcBytes],
      [
        { kind: 'source', source: 0, page: 3 },
        { kind: 'source', source: 0, page: 1 },
      ],
    );
    const pdfjs = await import('../src/engine/pdfjs');
    const buf = new Uint8Array(bytes);
    // engine/pdfjs loadPdf returns page count; text via worker getText? use
    // pdfjsLib directly through the worker seam is heavy here — assert page
    // count through pdf.js and text through pdf-lib extraction is NOT
    // available, so pdf.js count + a visual-text probe on page 1.
    const count = await pdfjs.getPageCount(buf);
    expect(count).toBe(2);
    const firstText = await pdfjs.getFirstPageText(buf);
    expect(firstText).toContain('PAGE THREE'); // output p1 = source p3
  });
});
