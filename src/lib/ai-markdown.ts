/*
 * AI OCR output conversion (v0.5.0 phase 4b, D10). OCR text is UNTRUSTED
 * input — a scanned page can spell out `<script>alert(1)</script>` or
 * `[x](javascript:...)` and the engine echoes it verbatim. The converter is
 * escape-then-format: structural HTML tables the engine emits are parsed
 * into markdown FIRST (cells escaped), everything else is entity-escaped,
 * and the final HTML is BUILT from escaped text through a fixed whitelist —
 * raw passthrough does not exist. Link hrefs allow only http/https/mailto/
 * anchors. The HTML preview additionally renders inside a sandboxed iframe
 * without allow-scripts (the tool's job).
 *
 * Per the SPIKE (Q5): GLM-OCR emits HTML <table> blocks + plain text lines;
 * headings rarely come back — the markdown layer keeps them when present.
 */

export interface ConvertedOutput {
  /** Normalized markdown (tables as pipes, rest as escaped-source text). */
  markdown: string;
  /** Whitelist-formatted HTML document body (safe by construction). */
  html: string;
  /** Raw engine text (the Text tab — render escaped client-side). */
  text: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodeEntities(s: string): string {
  // ONLY what the engine's own table markup needs; content inside cells is
  // taken as literal text and re-escaped — entities in cell text stay
  // escaped twice-safe through this decode → re-escape round trip.
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

const TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi;
const TR_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
const CELL_RE = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi;
/** Convert every engine <table> block into markdown pipe rows. */
export function engineTablesToMarkdown(raw: string): string {
  return raw.replace(TABLE_RE, (_m, body: string) => {
    const rows: string[][] = [];
    for (const trMatch of body.matchAll(TR_RE)) {
      const cells = [...trMatch[1].matchAll(CELL_RE)].map((c) => cellToText(c[1]));
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
    const [head, ...rest] = rows.map(pad);
    const lines = [
      `| ${head.join(' | ')} |`,
      `| ${Array(width).fill('---').join(' | ')} |`,
      ...rest.map((r) => `| ${r.join(' | ')} |`),
    ];
    return `\n${lines.join('\n')}\n`;
  });
}

/**
 * Cell inner "HTML" → literal text. The engine echoes glyph text verbatim,
 * so inner tags are NOT stripped (a cell that says `<script>x</script>` is
 * OCR CONTENT, not markup) — entities are decoded, whitespace collapsed;
 * rendering escapes it later.
 */
function cellToText(cellHtml: string): string {
  return decodeEntities(cellHtml).replace(/\s+/g, ' ').trim();
}

const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;

/** Inline markdown → whitelist-built HTML on ALREADY-ESCAPED text. */
function inlineToSafeHtml(escaped: string): string {
  // bold / italic / inline code — the markers themselves survived escaping
  let out = escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  // links: [text](href) — href must pass the scheme whitelist or the whole
  // link degrades to plain text (the escaped brackets stay visible).
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, href: string) => {
    if (!SAFE_HREF.test(href)) return m;
    return `<a href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>`;
  });
  return out;
}

/** Markdown-subset → whitelist HTML (input line content must be raw text). */
export function markdownToSafeHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inTable = false;
  let listOpen: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    // table block: header row + |---| separator + body rows
    if (/^\|.+\|\s*$/.test(trimmed)) {
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
      if (isSeparator) continue;
      if (!inTable) {
        closeList();
        out.push('<table><tbody>');
        inTable = true;
      }
      out.push(`<tr>${cells.map((c) => `<td>${inlineToSafeHtml(escapeHtml(c))}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();

    if (trimmed.length === 0) {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level}>${inlineToSafeHtml(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      if (listOpen !== 'ul') {
        closeList();
        out.push('<ul>');
        listOpen = 'ul';
      }
      out.push(`<li>${inlineToSafeHtml(escapeHtml(bullet[1]))}</li>`);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      if (listOpen !== 'ol') {
        closeList();
        out.push('<ol>');
        listOpen = 'ol';
      }
      out.push(`<li>${inlineToSafeHtml(escapeHtml(ordered[1]))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineToSafeHtml(escapeHtml(trimmed))}</p>`);
  }
  closeTable();
  closeList();
  return out.join('\n');
}

/** Full pipeline: engine raw text → { markdown, html, text }. */
export function convertEngineOutput(raw: string): ConvertedOutput {
  const text = raw;
  const markdown = engineTablesToMarkdown(raw).trim();
  const body = markdownToSafeHtml(markdown);
  const html = `<!doctype html>\n<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:14px/1.6 system-ui,sans-serif;margin:1rem;color:#111}table{border-collapse:collapse;margin:.75rem 0}td,th{border:1px solid #bbb;padding:4px 10px}code{background:#f4f4f6;padding:1px 4px;border-radius:3px}</style></head><body>${body}</body></html>`;
  return { markdown, html, text };
}
