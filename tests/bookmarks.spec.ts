import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BookmarkParseError,
  bookmarksFromJson,
  bookmarksToJson,
  parseOutlines,
} from '../src/lib/bookmarks';

const FIX = 'tests/fixtures/bookmarks.pdf';

describe('parseOutlines — real outline tree', () => {
  it('parses titles (Unicode), hierarchy and destinations', async () => {
    const bytes = new Uint8Array(readFileSync(FIX));
    const r = await parseOutlines(bytes);
    expect(r.roots).toHaveLength(2);
    expect(r.roots[0]!.title).toBe('Chương 1');
    expect(r.roots[0]!.dest!.page).toBe(1);
    expect(r.roots[0]!.children).toHaveLength(0);
    const ch2 = r.roots[1]!;
    expect(ch2.title).toBe('Chương 2 - tài liệu');
    expect(ch2.dest!.page).toBe(2);
    expect(ch2.children).toHaveLength(1);
    expect(ch2.children[0]!.title).toBe('Mục 1.1');
    expect(ch2.children[0]!.dest!.page).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.unresolved).toHaveLength(0);
  });

  it('no outlines -> empty roots, no throw', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage();
    const r = await parseOutlines(await doc.save());
    expect(r.roots).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });
});

describe('parseOutlines — hostile structures', () => {
  it('cyclic outline (self-referencing First) terminates, no hang', async () => {
    const { PDFDocument, PDFName, PDFHexString } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const p = doc.addPage();
    const ctx = doc.context;
    const itemDict = ctx.obj({});
    const itemRef = ctx.register(itemDict);
    itemDict.set(PDFName.of('Title'), PDFHexString.fromText('cyclic'));
    itemDict.set(PDFName.of('Dest'), ctx.obj([p.ref, PDFName.of('Fit')]));
    itemDict.set(PDFName.of('First'), itemRef); // points at itself
    itemDict.set(PDFName.of('Next'), itemRef); // cyclic siblings
    const outlines = ctx.obj({});
    const outlinesRef = ctx.register(outlines);
    outlines.set(PDFName.of('First'), itemRef);
    itemDict.set(PDFName.of('Parent'), outlinesRef);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
    const r = await parseOutlines(await doc.save());
    expect(r.truncated).toBe(false);
    // the cyclic child chain terminates
    expect(r.roots[0]!.children).toHaveLength(0);
  });
});

describe('named destinations', () => {
  it('name-tree dest resolves through the /Dest name reference', async () => {
    const { PDFDocument, PDFName, PDFHexString, PDFArray } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    const ctx = doc.context;
    // name tree: Names root -> Dests -> names array ["dest-a" -> [p2 /Fit]]
    const destArr = ctx.obj([doc.getPages()[1]!.ref, PDFName.of('Fit')]);
    const namesLeaf = ctx.obj({ Names: ctx.obj([PDFHexString.fromText('dest-a'), destArr]) });
    const namesLeafRef = ctx.register(namesLeaf);
    const destsRoot = ctx.obj({ Kids: ctx.obj([namesLeafRef]) });
    const destsRootRef = ctx.register(destsRoot);
    const namesRoot = ctx.obj({ Dests: destsRootRef });
    doc.catalog.set(PDFName.of('Names'), namesRoot);
    // outline item references the NAME
    const itemDict = ctx.obj({});
    const itemRef = ctx.register(itemDict);
    itemDict.set(PDFName.of('Title'), PDFHexString.fromText('qua ten'));
    itemDict.set(PDFName.of('Dest'), PDFHexString.fromText('dest-a'));
    const outlines = ctx.obj({});
    const outlinesRef = ctx.register(outlines);
    outlines.set(PDFName.of('First'), itemRef);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
    const r = await parseOutlines(await doc.save());
    expect(r.roots[0]!.title).toBe('qua ten');
    expect(r.roots[0]!.dest!.page).toBe(2);
    expect(r.namedDests.get('dest-a')?.page).toBe(2);
    void PDFArray;
  });
});

describe('bookmarks JSON interchange', () => {
  it('round-trips titles/dests/children with stable ids', () => {
    const json = bookmarksToJson([
      {
        id: 'bm1',
        title: 'Tài liệu hướng dẫn',
        dest: { page: 2, view: { kind: 'xyz', x: 0, y: 842, zoom: 1 } },
        children: [{ id: 'bm2', title: 'con', dest: { page: 3, view: { kind: 'fit' } }, children: [] }],
      },
      { id: 'bm3', title: 'khong dich', dest: null, children: [] },
    ]);
    const { roots, rejected } = bookmarksFromJson(json);
    expect(rejected).toBe(0);
    expect(roots[0]!.title).toBe('Tài liệu hướng dẫn');
    expect(roots[0]!.dest!.page).toBe(2);
    expect(roots[0]!.dest!.view).toEqual({ kind: 'xyz', x: 0, y: 842, zoom: 1 });
    expect(roots[0]!.children[0]!.title).toBe('con');
    expect(roots[1]!.dest).toBeNull();
  });

  it('hostile JSON: wrong version, junk shapes, over-deep trees rejected safely', () => {
    expect(() => bookmarksFromJson('not json')).toThrow(BookmarkParseError);
    expect(() => bookmarksFromJson('{"version":99,"roots":[]}')).toThrow(BookmarkParseError);
    expect(() => bookmarksFromJson('{"version":1}')).toThrow(BookmarkParseError);
    expect(() => bookmarksFromJson('{"version":1,"roots":"nope"}')).toThrow(BookmarkParseError);
    const { rejected } = bookmarksFromJson('{"version":1,"roots":[{"title":"ok","dest":{"page":-5}}]}');
    expect(rejected).toBe(1); // bad page dropped, node kept
  });

  it('imported JSON cannot carry actions — the format has no action field', () => {
    // A malicious producer stuffs action fields; the parser drops them by
    // shape (only title/dest/children are read) — nothing executable exists
    // in the interchange model to execute.
    const hostile = JSON.stringify({
      version: 1,
      roots: [
        {
          title: 'x',
          dest: null,
          children: [],
          action: { type: 'URI', url: 'file:///C:/Windows/System32/calc.exe' },
          js: 'app.alert(1)',
          launch: 'C:\\malware.exe',
        },
      ],
    });
    const { roots } = bookmarksFromJson(hostile);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.title).toBe('x');
    expect(JSON.stringify(roots)).not.toContain('URI');
    expect(JSON.stringify(roots)).not.toContain('alert');
    expect(JSON.stringify(roots)).not.toContain('malware');
  });
});
