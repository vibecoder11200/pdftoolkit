import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

/** Two-page annotate e2e fixture: page 1 plain, page 2 /Rotate 90 — the
 * pdf.js position oracle must see the stamp at its VISUAL position on both. */
export async function buildAnnotateFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText('Page one body text.', { x: 48, y: 760, size: 11, font });
  const p2 = doc.addPage([595, 842]);
  p2.drawText('Page two body text.', { x: 48, y: 760, size: 11, font });
  p2.setRotation(degrees(90));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
}
