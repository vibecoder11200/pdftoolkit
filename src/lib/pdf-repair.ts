/*
 * Phase-8 best-effort repair composition (plan 261112-0955). User-triggered,
 * writes NEW output only. Posture (spike-pinned): qpdf exit 2/1 -> typed
 * refusal with NO output; signed inputs refuse BEFORE mutation; passwords
 * are used for the run but NEVER persisted or logged. Validation:
 * output nonempty (engine layer) + parsed page count + sampled text
 * comparison when the ORIGINAL is readable — mismatch refuses. When the
 * original is unreadable there is NO parity claim: the result is marked
 * unverifiable and the UI must present it as requiring user review.
 */

import { engine } from "../engine/client";
import { getPageCount, getFirstPageText } from "../engine/pdfjs";
import { sanitizeQpdfLines } from "./pdf-diagnostics";

export class RepairRefusedError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "RepairRefusedError";
  }
}

export interface RepairOutcome {
  bytes: Uint8Array;
  filename: string;
  qpdfExit: number;
  warnings: string[];
  /** "verified" or "unverifiable" (original unreadable: no parity claim). */
  verification: "verified" | "unverifiable";
}

export interface RepairDeps {
  hasSignature: (bytes: Uint8Array) => Promise<boolean>;
  repair: (bytes: Uint8Array, password?: string) => Promise<{ bytes: Uint8Array; exitCode: number; lines: string[] }>;
  pageCount: (bytes: Uint8Array) => Promise<number>;
  firstPageText: (bytes: Uint8Array) => Promise<string>;
}

/** Engine-backed legs; tests inject fakes over the same seams. */
const defaultDeps: RepairDeps = {
  hasSignature: (b) => engine.hasDigitalSignature(b),
  repair: (b, p) => engine.repairPdf(b, p),
  pageCount: (b) => getPageCount(b),
  firstPageText: (b) => getFirstPageText(b),
};

export async function runRepair(
  input: Uint8Array,
  baseName: string,
  password?: string,
  deps: RepairDeps = defaultDeps,
): Promise<RepairOutcome> {
  const signed = await deps.hasSignature(input);
  if (signed) {
    throw new RepairRefusedError("signed-input");
  }
  let originalPages: number | null = null;
  let originalText: string | null = null;
  let originalReadable = true;
  try {
    originalPages = await deps.pageCount(input);
    originalText = await deps.firstPageText(input);
  } catch {
    originalReadable = false;
  }
  let r: Awaited<ReturnType<typeof deps.repair>>;
  try {
    r = await deps.repair(input, password);
  } catch (e) {
    // engine-level typed refusal (exit 2/1: qpdf produced NO output) —
    // rethrow as the composition-level error the UI handles
    const code = (e as { exitCode?: number }).exitCode;
    throw new RepairRefusedError('qpdf-refused' + (typeof code === 'number' ? ':' + code : ''));
  }
  if (r.bytes.byteLength === 0) {
    throw new RepairRefusedError("empty-output");
  }
  let outPages: number | null = null;
  try {
    outPages = await deps.pageCount(r.bytes);
  } catch {
    throw new RepairRefusedError("output-unparseable");
  }
  if (originalReadable) {
    if (outPages !== originalPages) {
      throw new RepairRefusedError("page-count-mismatch");
    }
    let outText: string;
    try {
      outText = await deps.firstPageText(r.bytes);
    } catch {
      throw new RepairRefusedError('output-unreadable');
    }
    if (outText !== originalText) {
      throw new RepairRefusedError("text-mismatch");
    }
    return outcome(r, baseName, "verified");
  }
  return outcome(r, baseName, "unverifiable");
}

function outcome(
  r: { bytes: Uint8Array; exitCode: number; lines: string[] },
  baseName: string,
  verification: "verified" | "unverifiable",
): RepairOutcome {
  return {
    bytes: r.bytes,
    filename: baseName.replace(/\.pdf$/i, "") + "-sua-chua.pdf",
    qpdfExit: r.exitCode,
    warnings: sanitizeQpdfLines(r.lines),
    verification,
  };
}
