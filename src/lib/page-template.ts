/**
 * Pure page-number template renderer (v0.8.0, red-team finding 7): lives in
 * its own module with ZERO pdf-lib imports so the page-numbers tool's live
 * preview can import it statically without pulling pdf-lib into the entry
 * chunk (the engine imports it too, from inside the worker graph).
 *
 * Tokens: {n} {total} {date} {filename}. Unknown tokens pass through
 * literally (the spec'd behavior — the preview makes typos visible before a
 * run). {n} is the caller's page number (actual page + startNumber − 1);
 * {date} renders dd/mm/yyyy (vi convention, local device clock).
 */

export interface TemplateContext {
  /** Display number for this page (actual page number + startNumber − 1). */
  n: number;
  /** Total pages of the document (scope-independent). */
  total: number;
  /** Source filename; rendered as basename sans extension. */
  filename?: string;
  /** Preformatted date string; defaults to today's dd/mm/yyyy. */
  date?: string;
}

const TOKEN_RE = /\{(n|total|date|filename)\}/g;

export function formatDateVi(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

export function basenameSansExt(filename: string | undefined): string {
  if (!filename) return '';
  const base = filename.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

export function renderPageTemplate(template: string, ctx: TemplateContext): string {
  const date = ctx.date ?? formatDateVi(new Date());
  return template.replace(TOKEN_RE, (_m, token: string) => {
    switch (token) {
      case 'n':
        return String(ctx.n);
      case 'total':
        return String(ctx.total);
      case 'date':
        return date;
      case 'filename':
        return basenameSansExt(ctx.filename);
      default:
        return _m;
    }
  });
}
