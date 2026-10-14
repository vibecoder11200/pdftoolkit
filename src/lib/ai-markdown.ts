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
 * Per the v0.7.0 phase-2 A/B matrix (real engine): the PRIMARY engine table
 * form is GFM pipe rows (the legacy HTML <table> path stays for older
 * builds), and `$...$`/`$$...$$` math is emitted natively. The whitelist
 * HTML is also the DOCX export input contract (markdown-docx.ts): tables
 * carry thead/th header semantics, and math segments become data-latex
 * carrier spans that docx/html converts to OMML (its invalid-math path
 * keeps the literal text when a conversion fails).
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
 * rendering escapes it later. A literal `|` is backslash-escaped so the
 * markdown table split cannot turn one cell into two columns (review P2-4);
 * markdownToSafeHtml unescapes on re-split.
 */
function cellToText(cellHtml: string): string {
  return decodeEntities(cellHtml)
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('|', '\\|');
}

const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;

/**
 * Hostile-LaTeX guard (OCR math is attacker-controlled scanned content):
 * bound length + brace nesting before anything reaches a LaTeX→OMML
 * converter — try/catch handles throws but not pathological hangs. Exported
 * for the phase-4 unit tests (deep-nesting input trips the pre-check).
 */
export function mathSafe(latex: string): boolean {
  if (latex.length === 0 || latex.length > 500) return false;
  let depth = 0;
  for (const ch of latex) {
    if (ch === '{') {
      depth += 1;
      if (depth > 10) return false;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return true;
}

/** Inline markdown formatting (bold/italic/code/links) on escaped text. */
function inlineFormat(escaped: string): string {
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

/**
 * Inline markdown → whitelist-built HTML on ALREADY-ESCAPED text. Math
 * segments split FIRST (phase-4 red-team fix: a `$x$` inside a table cell
 * must never tear the table apart — the split is per TEXT NODE here): each
 * becomes a data-latex carrier span (docx/html → OMML; its invalid-math
 * path keeps the literal delimited source as the fallback text), and only
 * the plain segments run the emphasis/code/link passes so the inserted
 * markup is never re-processed.
 */
function inlineToSafeHtml(escaped: string): string {
  return escaped
    .split(/(\$\$[^$\n]+\$\$|\$[^$\n]+\$)/g)
    .map((part, i) => {
      if (i % 2 === 0) return inlineFormat(part);
      const display = part.startsWith('$$');
      const tex = part.slice(display ? 2 : 1, display ? -2 : -1);
      if (!mathSafe(tex)) return inlineFormat(part);
      return `<span data-latex="${tex}"${display ? ' display="block"' : ''}>${part}</span>`;
    })
    .join('');
}

/** Markdown-subset → whitelist HTML (input line content must be raw text). */
export function markdownToSafeHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inTable = false;
  /** Rows emitted in the current table. Row 0 → thead/th (Word header-row
   *  semantics: docx/html maps th to tableHeader — the repeat-on-new-page
   *  header); the first body row closes thead and opens tbody. Phase-4
   *  spike verdict: headerless td-only tables get NO tblHeader, so the
   *  synthesis happens here at the source. */
  let tableRows = 0;
  let listOpen: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };
  const closeTable = () => {
    if (inTable) {
      // Match the open structure: row 0 never happens while open, a
      // header-only table never opened tbody.
      out.push(tableRows <= 1 ? '</thead></table>' : '</tbody></table>');
      inTable = false;
      tableRows = 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    // table block: header row + |---| separator + body rows.
    // Split on UNescaped pipes only — `\|` is a literal pipe that came from
    // cellToText (a `|` inside OCR cell content), so unescape after splitting.
    if (/^\|.+\|\s*$/.test(trimmed)) {
      const cells = trimmed
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replaceAll('\\|', '|'));
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
      if (isSeparator) continue;
      if (!inTable) {
        closeList();
        out.push('<table><thead>');
        inTable = true;
        tableRows = 0;
      }
      const tag = tableRows === 0 ? 'th' : 'td';
      if (tableRows === 1) out.push('</thead><tbody>');
      tableRows += 1;
      out.push(`<tr>${cells.map((c) => `<${tag}>${inlineToSafeHtml(escapeHtml(c))}</${tag}>`).join('')}</tr>`);
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
