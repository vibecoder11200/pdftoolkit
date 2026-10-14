/*
 * Searchable-PDF "sandwich" for the AI OCR engines (v0.7.0 phase 3): the
 * page raster (JPEG) with an INVISIBLE Vietnamese-capable text layer stacked
 * over it in reading order. Built AT CLICK TIME from the original file bytes
 * + the per-page engine results — nothing is retained through the run
 * (bounded memory; page count always == results length; a crash/resume run
 * yields exactly the completed pages).
 *
 * Invisibility: `drawText(..., { opacity: 0 })` — NEVER raw
 * pushOperators/Tr 3. Both extract byte-perfect Vietnamese through pdf.js,
 * but raw operators carry the reproduced `fontKey` trap: referencing
 * `font.name` instead of the mangled `page.fontKey` yields a PDF that
 * renders fine and is silently unsearchable (the research spike's
 * root-caused failure). drawText does the resource bookkeeping internally.
 *
 * Vietnamese needs NO new font: the shipped Roboto-Regular.ttf subsets to
 * kilobytes via the proven embedFont(bytes, { subset: true }) + fontkit
 * pattern (fill-form-tool precedent). One embed per document, shared across
 * pages. JPEG (not PNG) for rasters: embedJpg re-embeds the compressed scan
 * losslessly; embedPng decodes and re-deflates.
 */

export interface SandwichPage {
  /** 1-based source page number. */
  index: number;
  /** Raw engine markdown for that page — normalized to display text here. */
  displayText: string;
}

export interface SandwichQuality {
  /** compact = 150 DPI (default) / archive = 300 DPI. FILE quality only —
   *  the engine input raster is unaffected (AI_DPI 150 / web 1024 cap). */
  dpi: 150 | 300;
}

/** Node-test seam: inject an @napi-rs/canvas renderer and/or font bytes so
 *  the pdf.js oracle runs without a DOM (?inline is a vite transform — node
 *  tests pass robotoBytes instead). Production uses the defaults. */
export interface SandwichDeps {
  renderPageJpeg?: (
    sourceBytes: Uint8Array,
    page: number,
    dpi: number,
  ) => Promise<Uint8Array>;
  robotoBytes?: Uint8Array;
}

/**
 * Engine markdown → display lines (the invisible layer carries DISPLAY
 * text, not markdown syntax — copy-paste must read like tesseract's):
 * headings stripped of `#` markers, table rows space-joined with separator
 * rows dropped, escaped `\|` unescaped, emphasis/code/math delimiters
 * stripped, empty lines dropped.
 */
export function displayLines(markdown: string): string[] {
  const out: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^\|.+\|$/.test(line)) {
      // Split on UNescaped pipes only (the same rule as the markdown
      // converter), drop the |---| separator row, unescape cells, space-join.
      const cells = line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => cleanInline(c.trim()));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      out.push(cells.filter((c) => c.length > 0).join(' '));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    out.push(cleanInline(heading ? heading[1] : line));
  }
  return out;
}

function cleanInline(s: string): string {
  return s
    .replaceAll('\\|', '|')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$\$([^$]+)\$\$/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .trim();
}

/** Roboto via the ?inline data-URL pattern; atob decode (fetch() on data:
 *  URLs is rejected by current Chromium — fill-form-tool precedent). Lazy
 *  ON USE, not on module load: node has no vite ?inline transform, so its
 *  tests inject robotoBytes and this import never runs there. */
async function loadRoboto(): Promise<Uint8Array> {
  const m = await import('../assets/fonts/Roboto-Regular.ttf?inline');
  const b64 = m.default.slice(m.default.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Production raster path: render on THIS module's OWN canvas (never the
 *  run's shared canvas — the ordering trap where a sandwich render could
 *  corrupt the native engine input or exceed the 16 MB dataUrl ceiling),
 *  JPEG q0.75 (the measured ~110 KB/page @150 DPI sweet spot). */
async function defaultRenderPageJpeg(
  sourceBytes: Uint8Array,
  page: number,
  dpi: number,
): Promise<Uint8Array> {
  const { renderPageToCanvas } = await import('../engine/pdfjs');
  const canvas = document.createElement('canvas');
  await renderPageToCanvas(sourceBytes, page, canvas, dpi / 72);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
  if (!blob) throw new Error('sandwich: canvas toBlob failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Build the sandwich document. `pages` in reading order (the caller passes
 * results sorted by page — partial post-crash runs pass the completed
 * pages). `deps.renderPageJpeg` is the node-test seam: the browser path is
 * the default; tests inject an @napi-rs/canvas renderer so the pdf.js
 * oracle can run without a DOM.
 */
export async function buildSandwichPdf(
  sourceBytes: Uint8Array,
  pages: SandwichPage[],
  quality: SandwichQuality,
  deps: SandwichDeps = {},
): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('sandwich: no pages');
  const render = deps.renderPageJpeg ?? defaultRenderPageJpeg;
  const [{ PDFDocument }, fontkit] = await Promise.all([
    import('pdf-lib'),
    import('@pdf-lib/fontkit'),
  ]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit.default);
  const font = await doc.embedFont(deps.robotoBytes ?? (await loadRoboto()), {
    subset: true,
  });
  doc.setLanguage('vie');
  doc.setTitle('pdftoolkit-ocr');
  doc.setProducer('pdftoolkit');
  for (const p of pages) {
    const jpeg = await render(sourceBytes, p.index, quality.dpi);
    const img = await doc.embedJpg(jpeg);
    // Page points = physical size (pixels × 72/dpi) so the 6–12 pt text
    // layer sits at real-world scale over the raster.
    const width = (img.width * 72) / quality.dpi;
    const height = (img.height * 72) / quality.dpi;
    const page = doc.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
    const lines = displayLines(p.displayText);
    if (lines.length === 0) continue;
    // No-bbox placement (documented design decision — the engine emits no
    // spatial data): uniform line stack, margins ≈5%, reading order.
    const margin = height * 0.05;
    const fontSize = Math.min(12, Math.max(6, (height * 0.9) / lines.length));
    const lineHeight = (height - 2 * margin) / lines.length;
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: margin,
        y: height - margin - (i + 0.5) * lineHeight - fontSize / 3,
        size: fontSize,
        font,
        opacity: 0,
      });
    });
  }
  return doc.save({ useObjectStreams: false });
}
