/*
 * Markdown/OCR → DOCX export (v0.7.0 phase 4). Runs in the PDF worker via
 * the dynamic import below (the ~430 KB gz of docx chunks only load when a
 * user actually exports; heavyweight byte work never touches the main
 * thread — the zip.ts precedent).
 *
 * Two input shapes:
 * - AI engines: raw per-page engine markdown → ai-markdown's whitelist
 *   converter (engineTablesToMarkdown → markdownToSafeHtml, whose math
 *   segments are data-latex carrier spans and whose tables carry thead/th
 *   header semantics) → docx/html htmlToContent. htmlToContent is ASYNC and
 *   converts to native Word headings/tables/equations; its invalid-math
 *   path keeps the literal delimited source when latexToMath throws, so a
 *   math failure can never fail the export.
 * - Tesseract: plain text → flat paragraphs.
 *
 * Pages are built PER-PAGE from the run results with page breaks between —
 * never from the joined done-view artifact (its `--- N trang ---`
 * separators are locale-dependent and must not bake into the file).
 */

import { engineTablesToMarkdown, markdownToSafeHtml } from './ai-markdown';

export interface DocxPages {
  /** Raw per-page text in reading order (engine markdown or tesseract
   *  plain text), 1 entry per page. */
  texts: string[];
  /** Tesseract mode: flat paragraphs, no markdown conversion. */
  flat?: boolean;
}

/** Build the .docx bytes for the given pages (worker-side entry point). */
export async function markdownToDocx({ texts, flat = false }: DocxPages): Promise<Uint8Array> {
  if (texts.length === 0) throw new Error('docx export: no pages');
  const [{ Document, Packer, Paragraph }, { htmlToContent }] = await Promise.all([
    import('docx'),
    import('docx/html'),
  ]);

  type DocxChild = NonNullable<
    NonNullable<ConstructorParameters<typeof Document>[0]['sections']>[number]['children']
  >[number];
  const children: DocxChild[] = [];
  for (const [i, text] of texts.entries()) {
    if (i > 0) children.push(new Paragraph({ pageBreakBefore: true }));
    if (flat) {
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) children.push(new Paragraph(line));
      }
      continue;
    }
    const fragment = markdownToSafeHtml(engineTablesToMarkdown(text).trim());
    if (fragment.length > 0) children.push(...(await htmlToContent(fragment)));
  }

  const doc = new Document({
    title: 'pdftoolkit-ocr',
    creator: 'pdftoolkit',
    sections: [{ children }],
  });
  // Packer.toBuffer serializes through jszip's NODEBUFFER type — unsupported
  // in the browser (the pdf worker). Node (vitest) has no Blob path choice:
  // toBlob throws there, so fork on Blob availability.
  if (typeof Blob !== 'undefined') {
    return new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
  }
  return new Uint8Array(await Packer.toBuffer(doc));
}
