import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { expose } from 'comlink';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  EditTextRefusedError,
  editTextRuns,
  redactCensus,
} from '../src/engine/pdf-lib';
import { groupRuns, runEditTextPipeline, type EditRunMark } from '../src/lib/edit-text-pipeline';
import { __setEngineWorkerSpawnForTests, engine } from '../src/engine/client';
import { getPageTextItems, getPageVisualSize } from '../src/engine/pdfjs';

/*
 * Text-edit M3a oracle (v0.9.0 phase 6). The engine gates: census-clean
 * pages only, exact-block removal (partial → refuse, input untouched),
 * pre-mutation width fit, scoped non-content residue scan. The pipeline
 * gates: RUN-SCOPED semantic verify (finding 13) — the removed run's items
 * are gone by rect, the replacement extracts, a same-page TWIN of the run
 * survives untouched, and no rasterize-recovery exists anywhere in the op.
 */

const ROOT = join(import.meta.dirname, '..');
const ROBOTO = join(ROOT, 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

const LINE = 'TOTAL AMOUNT DUE 1250';

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // Page 1: the target line + two neighbour lines (same BT..ET-free
  // separate blocks — pdf-lib emits one BT..ET per drawText call).
  const p1 = doc.addPage([400, 300]);
  p1.drawText('Invoice header text', { x: 40, y: 250, size: 12, font: helv });
  p1.drawText(LINE, { x: 40, y: 200, size: 12, font: helv });
  p1.drawText('Footer note line', { x: 40, y: 150, size: 12, font: helv });
  // Page 2: DUPLICATE lines (finding 13 — editing ONE of the two is valid).
  const p2 = doc.addPage([400, 300]);
  p2.drawText(LINE, { x: 40, y: 220, size: 12, font: helv });
  p2.drawText(LINE, { x: 40, y: 120, size: 12, font: helv });
  // Page 3: a census-flagged page (text inside a Form XObject).
  const p3 = doc.addPage([400, 300]);
  const { PDFRawStream, PDFDict, PDFName, PDFNumber } = await import('pdf-lib');
  const xoDict = PDFDict.withContext(doc.context);
  xoDict.set(PDFName.of('Type'), PDFName.of('XObject'));
  xoDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  xoDict.set(PDFName.of('BBox'), doc.context.obj([PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(400), PDFNumber.of(300)]));
  const xo = PDFRawStream.of(
    xoDict,
    new TextEncoder().encode('BT /F1 12 Tf 40 100 Td (Hidden xobject text) Tj ET'),
  );
  const xoRef = doc.context.register(xo);
  const res = PDFDict.withContext(doc.context);
  const xoRes = PDFDict.withContext(doc.context);
  xoRes.set(PDFName.of('Fx'), xoRef);
  res.set(PDFName.of('XObject'), xoRes);
  p3.node.set(PDFName.of('Resources'), res);
  p3.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      PDFRawStream.of(
        PDFDict.withContext(doc.context),
        new TextEncoder().encode('q /Fx Do Q'),
      ),
    ),
  );
  return doc.save({ useObjectStreams: false });
}

/** Visual-space descriptor of the run drawn at (40, y) size 12 on page p. */
async function markFor(bytes: Uint8Array, page: number, needle: string, occurrence = 0): Promise<EditRunMark & { page: number }> {
  const { width: vw, height: vh } = await getPageVisualSize(bytes, page);
  const items = await getPageTextItems(bytes, page);
  const grouped = groupRuns(
    items.filter((i) => 'str' in i) as { str: string; transform: number[]; width: number; height: number }[],
    vw,
    vh,
  );
  const matches = grouped.filter((r) => r.text === needle);
  expect(matches.length, `run "${needle}" on page ${page}`).toBeGreaterThan(occurrence);
  const r = matches[occurrence]!;
  return {
    id: `m${page}-${occurrence}`,
    page,
    nx: r.nx,
    nyTop: r.nyTop,
    nw: r.nw,
    nh: r.nh,
    nyBaselineTop: r.nyBaselineTop,
    text: r.text,
    replacement: '',
    fontSize: r.fontSize,
  };
}

/** Fraction mark → visual-space EditTextRun (the engine's unit). */
async function toRun(
  mark: EditRunMark,
  bytes: Uint8Array,
): Promise<import('../src/engine/pdf-lib').EditTextRun> {
  const { width: vw, height: vh } = await getPageVisualSize(bytes, mark.page);
  return {
    page: mark.page,
    rect: {
      x: mark.nx * vw,
      y: (1 - mark.nyTop - mark.nh) * vh,
      w: mark.nw * vw,
      h: mark.nh * vh,
    },
    baselineY: (1 - mark.nyBaselineTop) * vh,
    text: mark.text,
    replacement: mark.replacement,
    fontSize: mark.fontSize,
  };
}

describe('groupRuns — contiguous-baseline heuristic', () => {
  it('groups same-band adjacent items, splits across bands and big gaps', () => {
    const vw = 400;
    const vh = 300;
    const runs = groupRuns(
      [
        { str: 'Hello ', transform: [12, 0, 0, 12, 40, 200], width: 36, height: 12 },
        { str: 'world', transform: [12, 0, 0, 12, 80, 200], width: 30, height: 12 },
        { str: 'Next line', transform: [12, 0, 0, 12, 40, 150], width: 54, height: 12 },
        { str: 'Far away', transform: [12, 0, 0, 12, 300, 200], width: 48, height: 12 },
      ],
      vw,
      vh,
    );
    const texts = runs.map((r) => r.text);
    expect(texts).toContain('Hello world');
    expect(texts).toContain('Next line');
    expect(texts).toContain('Far away');
    const hw = runs.find((r) => r.text === 'Hello world')!;
    expect(hw.fontSize).toBe(12);
  });
});

describe('editTextRuns — engine gates', () => {
  it('removes the run and draws the replacement (real, searchable text)', async () => {
    const base = await buildFixture();
    const mark = await markFor(base, 1, LINE);
    const out = await editTextRuns(
      base,
      { runs: [{ ...(await toRun({ ...mark, replacement: 'TOTAL 9999' }, base)) }] },
      robotoBytes(),
    );
    const items = await getPageTextItems(out.bytes, 1);
    const strings = items.map((i) => i.str).join(' ');
    expect(strings).toContain('TOTAL 9999');
    expect(strings).not.toContain(LINE);
    expect(strings).toContain('Invoice header text'); // neighbours untouched
    expect(strings).toContain('Footer note line');
  });

  it('duplicate-string fixture: editing ONE of two identical runs passes', async () => {
    const base = await buildFixture();
    const mark0 = await markFor(base, 2, LINE, 0);
    const mark1 = await markFor(base, 2, LINE, 1);
    expect(mark0.nyTop).not.toBe(mark1.nyTop);
    const out = await editTextRuns(
      base,
      { runs: [{ ...(await toRun({ ...mark0, replacement: 'EDITED ONE' }, base)) }] },
      robotoBytes(),
    );
    const strings = (await getPageTextItems(out.bytes, 2)).map((i) => i.str).join(' ');
    expect(strings).toContain('EDITED ONE');
    // Exactly ONE copy of the original survives (the unedited twin)…
    const survivors = strings.split(LINE).length - 1;
    expect(survivors).toBe(1);
  });

  it('replacement overflow beyond tolerance refuses BEFORE mutation', async () => {
    const base = await buildFixture();
    const mark = await markFor(base, 1, LINE);
    await expect(
      editTextRuns(
        base,
        { runs: [{ ...(await toRun({ ...mark, replacement: 'X'.repeat(200) }, base)), tolerance: 0 }] },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(EditTextRefusedError);
  });

  it('multi-line replacement refuses', async () => {
    const base = await buildFixture();
    const mark = await markFor(base, 1, LINE);
    await expect(
      editTextRuns(
        base,
        { runs: [{ ...(await toRun({ ...mark, replacement: 'two\nlines' }, base)) }] },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(EditTextRefusedError);
  });

  it('a census-flagged page (text XObject) refuses', async () => {
    const base = await buildFixture();
    const census = await redactCensus(base);
    expect(census.pages.find((p) => p.page === 3)?.kinds).toContain('xobject-text');
    await expect(
      editTextRuns(
        base,
        {
          runs: [
            { page: 3, rect: { x: 40, y: 90, w: 150, h: 14 }, baselineY: 100, text: 'anything', replacement: 'x' },
          ],
        },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(EditTextRefusedError);
  });

  it('pure white-out (empty replacement) removes the text entirely', async () => {
    const base = await buildFixture();
    const mark = await markFor(base, 1, LINE);
    const out = await editTextRuns(
      base,
      { runs: [{ ...(await toRun({ ...mark, replacement: '' }, base)) }] },
      robotoBytes(),
    );
    const strings = (await getPageTextItems(out.bytes, 1)).map((i) => i.str).join(' ');
    expect(strings).not.toContain(LINE);
    expect(strings).toContain('Invoice header text');
  });
});

describe('runEditTextPipeline — run-scoped semantic leg', () => {
  // The pipeline dials the engine through the comlink worker seam; under
  // vitest the worker constructor is injected, serving the REAL op.
  interface Handle {
    worker: Worker;
    fireError(): void;
  }
  const spawned: Handle[] = [];
  __setEngineWorkerSpawnForTests(() => {
    const { port1, port2 } = new MessageChannel();
    expose(
      {
        editTextRuns: (b: Uint8Array, spec: Parameters<typeof engine.editTextRuns>[1]) =>
          editTextRuns(b, spec, robotoBytes()),
      },
      port2,
    );
    const w = {
      onerror: null as ((e: Event) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: (data: unknown, transfer?: Transferable[]) =>
        (port1 as { postMessage(d: unknown, t?: Transferable[]): void }).postMessage(data, transfer),
      addEventListener: (type: string, cb: EventListener) => port1.addEventListener(type, cb as EventListener),
      removeEventListener: (type: string, cb: EventListener) => port1.removeEventListener(type, cb as EventListener),
      start: () => port1.start(),
      terminate: () => {
        port1.close();
        port2.close();
      },
    };
    const handle: Handle = { worker: w as unknown as Worker, fireError: () => w.onerror?.(new Event('error')) };
    spawned.push(handle);
    return handle.worker;
  });
  afterAll(() => __setEngineWorkerSpawnForTests(null));

  it('end-to-end: engine op + verify pass on a valid single-run edit', async () => {
    const base = await buildFixture();
    const mark = await markFor(base, 1, LINE);
    const sizes = new Map([[1, await getPageVisualSize(base, 1)]]);
    const out = await runEditTextPipeline(
      base,
      [{ ...mark, replacement: 'TOTAL 42' }],
      sizes,
      { fontTtf: robotoBytes() },
    );
    const strings = (await getPageTextItems(out, 1)).map((i) => i.str).join(' ');
    expect(strings).toContain('TOTAL 42');
  });

  it('duplicate twin: pipeline passes and the twin keeps extracting', async () => {
    const base = await buildFixture();
    const mark0 = await markFor(base, 2, LINE, 0);
    const sizes = new Map([[2, await getPageVisualSize(base, 2)]]);
    const out = await runEditTextPipeline(
      base,
      [{ ...mark0, replacement: 'FIRST EDITED' }],
      sizes,
      { fontTtf: robotoBytes() },
    );
    const strings = (await getPageTextItems(out, 2)).map((i) => i.str).join(' ');
    expect(strings).toContain('FIRST EDITED');
    expect(strings).toContain(LINE); // the twin — a VALID edit, not residue
  });

  it('a rect over empty space refuses as a no-op (no blocks there)', async () => {
    const base = await buildFixture();
    const sizes = new Map([[1, await getPageVisualSize(base, 1)]]);
    await expect(
      runEditTextPipeline(
        base,
        [
          {
            id: 'ghost',
            page: 1,
            nx: 0.9,
            nyTop: 0.95,
            nw: 0.05,
            nh: 0.01,
            nyBaselineTop: 0.96,
            text: 'not there',
            replacement: '',
            fontSize: 12,
          },
        ],
        sizes,
        { fontTtf: robotoBytes() },
      ),
    ).rejects.toMatchObject({ name: 'EditTextRefusedError' }) // name-only clone across comlink;
  });

  it('no recovery: a refused edit never returns partial output (bytes equal)', async () => {
    const base = await buildFixture();
    const before = base.slice();
    const mark = await markFor(base, 1, LINE);
    await expect(
      editTextRuns(
        base,
        {
          runs: [
            { ...(await toRun({ ...mark, replacement: 'OK' }, base)) },
            { page: 9, rect: { x: 0, y: 0, w: 10, h: 10 }, baselineY: 5, text: 'x', replacement: 'y' },
          ],
        },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(EditTextRefusedError);
    expect(base).toEqual(before);
  });
});
