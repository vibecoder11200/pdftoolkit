import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/*
 * Shared redact e2e fixture (web + desktop specs). Two pages, Helvetica:
 * page 1 is census-clean (surgical-eligible) and carries the secret in the
 * header line; page 2 carries the secret in an AcroForm TEXT FIELD — a
 * census-flagged construct (widget) that forces the raster tier, and a
 * doc-level channel (acroform:V) the scrub must clean. The doc Title also
 * carries the secret (info:Title channel).
 */

export const REDACT_SECRET = 'SECRET-123-ABC';
export const REDACT_KEYWORDS = 'SECRET-123-ABC';

export async function buildRedactFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${REDACT_SECRET} memo`);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const p1 = doc.addPage([595, 842]);
  p1.drawText(`Header: ${REDACT_SECRET}`, { x: 48, y: 800, size: 14, font });
  p1.drawText('Body line one is plain public text.', { x: 48, y: 760, size: 11, font });
  p1.drawText('Body line two is also plain public text.', { x: 48, y: 740, size: 11, font });
  p1.drawRectangle({ x: 48, y: 80, width: 200, height: 60, color: rgb(0.9, 0.9, 0.9) });

  const p2 = doc.addPage([595, 842]);
  p2.drawText('Second page public body text.', { x: 48, y: 760, size: 11, font });
  const form = doc.getForm();
  const field = form.createTextField('note.field');
  field.setText(REDACT_SECRET);
  field.addToPage(p2, { x: 48, y: 640, width: 260, height: 24 });

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
}
