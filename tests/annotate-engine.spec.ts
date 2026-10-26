import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees as pdfLibDegrees } from 'pdf-lib';
import { visualToPageSpace, visibleGeometry } from '../src/engine/pdf-lib';

/*
 * Annotate engine (v0.9.0 phase 4) — placement-math property checks for the
 * shared geometry primitives (the extension of the watermark-engine
 * contract). The standalone stampAnnotations op and its ink-oracle matrix
 * were removed (superseded by the composed applyAnnotate; see
 * annotate-ap.spec.ts for the live-path coverage: mixed stamps + annots,
 * encrypted refusal, fail-closed refusals, crash-and-retry).
 */

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // Rotation sweep on full A6-ish pages.
  for (const rot of [0, 90, 180, 270]) {
    const page = doc.addPage([400, 300]);
    page.drawText(`rot ${rot}`, { x: 20, y: 20, size: 10, font: helv });
    page.setRotation(pdfLibDegrees(rot));
  }
  // Cropped + rotated page: CropBox [50,50,250,200] → visual 200×150 @ rot 90.
  const cropped = doc.addPage([400, 300]);
  cropped.setCropBox(50, 50, 250, 200);
  cropped.setRotation(pdfLibDegrees(90));
  return doc.save({ useObjectStreams: false });
}

describe('annotate placement math (geometry primitives)', () => {
  it('visualToPageSpace round-trips the matrix (spot checks)', async () => {
    const libDoc = await PDFDocument.load(await buildFixture(), { ignoreEncryption: true });
    const cropped = libDoc.getPage(4); // 0-based index 4 = page 5 (cropped, rot 90)
    const geom = visibleGeometry(cropped);
    expect(geom.visualWidth).toBe(200);
    expect(geom.visualHeight).toBe(250);
    // rot 90: visual BL → user right-bottom of the crop box; visual TR → user
    // left-top (lx = vh − vy, ly = vx, offset by the crop origin).
    const bl = visualToPageSpace(0, 0, geom);
    expect(bl.x).toBeCloseTo(300);
    expect(bl.y).toBeCloseTo(50);
    const topRight = visualToPageSpace(200, 250, geom);
    expect(topRight.x).toBeCloseTo(50);
    expect(topRight.y).toBeCloseTo(250);
  });
});
