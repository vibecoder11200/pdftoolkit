/*
 * Phase-8 diagnostics composition (plan 261112-0955). Read-only: openability,
 * password requirement, page info, structural warnings from the qpdf --check
 * leg. NOT a malware/security scan — the UI must carry that disclosure, and
 * exit 0 is never a semantic-completeness guarantee. Report lines are
 * SANITIZED: worker argv[0] prefixes and /tmp paths stripped, bounded to 8
 * lines x 160 chars, and passwords are never echoed (qpdf does not echo
 * them; the composition never logs the caller-supplied password).
 */

import { getPageCount } from "../engine/pdfjs";
import { engine } from "../engine/client";

export interface PdfDiagReport {
  /** pdf.js can open and parse it. */
  readable: boolean;
  /** Encrypted (pdf.js PasswordException or qpdf invalid-password line). */
  encrypted: boolean;
  /** An empty/usable password was NOT accepted. */
  needsPassword: boolean;
  pageCount: number | null;
  /** qpdf --check exit code (0 ok, 2 errors, 3 warnings). */
  qpdfExit: number | null;
  /** Sanitized structural warning/error lines (bounded). */
  warnings: string[];
}

type QpdfRawResult = { exitCode: number; lines: string[] };

const MAX_LINES = 8;
const MAX_LINE = 160;

/** Strip the worker-script argv[0] prefix qpdf prepends, /tmp paths, and bound. */
export function sanitizeQpdfLines(lines: string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of lines) {
    let l = raw;
    l = l.replace(/^[^:]+: /, ""); // argv[0] program prefix
    l = l.replace(/\/tmp\/[^ :)]+/g, "<tmp>");
    l = l.trim();
    if (l.length === 0) continue;
    l = l.slice(0, MAX_LINE);
    if (!cleaned.includes(l)) cleaned.push(l);
    if (cleaned.length >= MAX_LINES) break;
  }
  return cleaned;
}

export async function runDiagnostics(bytes: Uint8Array): Promise<PdfDiagReport> {
  let readable = false;
  let encrypted = false;
  let needsPassword = false;
  let pageCount: number | null = null;
  try {
    pageCount = await getPageCount(bytes);
    readable = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message + " " + e.name : String(e);
    if (/password/i.test(msg)) {
      encrypted = true;
      needsPassword = true;
    }
  }
  let qpdfExit: number | null = null;
  let warnings: string[] = [];
  try {
    const r: QpdfRawResult = await engine.inspectPdf(bytes);
    qpdfExit = r.exitCode;
    warnings = sanitizeQpdfLines(r.lines);
    if (qpdfExit === 2 && warnings.some((l) => /invalid password/i.test(l))) {
      encrypted = true;
      needsPassword = true;
    }
  } catch {
    // qpdf leg is best-effort; pdf.js leg already classified readability
  }
  return { readable, encrypted, needsPassword, pageCount, qpdfExit, warnings };
}
