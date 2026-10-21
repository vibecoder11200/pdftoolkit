import { engine } from '../engine/client';
import type { PdfInfo } from '../engine/pdf-lib';
import { MAX_FILE_BYTES, sniffHeicName } from './file-accept';

export type SuggestSlug = 'merge' | 'compress' | 'img-to-pdf' | 'encrypt' | 'watermark' | 'page-numbers';

export interface Suggestion {
  slug: SuggestSlug;
  /** Only set for locked PDFs: land on the encrypt tool in decrypt mode. */
  mode?: 'decrypt';
  reasonKey: string;
  /** Single-file tool ranked for a multi-file drop: the sheet explains that
   * only the PDF (not every dropped file) will be loaded. */
  partial?: boolean;
}

export type RejectReason = 'not-pdf' | 'unsupported' | 'heic-refused' | 'too-large' | 'corrupt';

export interface RejectedFile {
  name: string;
  reason: RejectReason;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  /** Single-PDF case: the sheet also lists every tool for this file. */
  showAllTools: boolean;
  rejected: RejectedFile[];
}

export interface SuggestDeps {
  /** Injectable so unit tests never touch the Worker. */
  loadPdfInfo?: (bytes: Uint8Array) => Promise<PdfInfo>;
}

// Tier-2 (worker parse) runs only when it is cheap: ≤3 PDFs, each ≤10MB.
// Past the cap, locked/corrupt detection is skipped rather than guessed.
const TIER2_MAX_FILES = 3;
const TIER2_MAX_BYTES = 10 * 1024 * 1024;
const TIER2_TIMEOUT_MS = 3000;

const IMAGE_EXT = /\.(jpe?g|png)$/i;
const PDF_EXT = /\.pdf$/i;

/**
 * Locked-PDF detection. Exported for the tools' decrypt CTA (v0.8.0 finding
 * 14 — this check used to be module-private; pdf-lib's EncryptedPDFError
 * carries name "Error" at runtime, so the /encrypted/i message is the
 * reliable half of this check). Comlink rethrows worker errors preserving
 * name/message; accept either.
 */
export function isEncryptedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'EncryptedPDFError' || /encrypted/i.test(err.message))
  );
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('suggest tier-2 timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

async function hasPdfMagic(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return (
    head.length >= 5 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46 &&
    head[4] === 0x2d
  );
}

/**
 * Classify dropped files with cheap signals and rank tool suggestions.
 * Tier 1 (sync): extension, count, total size, PDF magic bytes.
 * Tier 2 (worker, capped): parse for lock state and corrupt detection.
 * Never throws — failures become rejected rows the sheet can display.
 */
export async function buildSuggestions(
  files: File[],
  deps: SuggestDeps = {},
): Promise<SuggestResult> {
  const loadPdfInfo = deps.loadPdfInfo ?? (async (bytes) => (await engine.loadPdf(bytes)).info);

  const pdfs: File[] = [];
  const images: File[] = [];
  const rejected: RejectedFile[] = [];

  for (const file of files) {
    if (file.type === 'image/heic' || file.type === 'image/heif' || sniffHeicName(file.name)) {
      rejected.push({ name: file.name, reason: 'heic-refused' });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      rejected.push({ name: file.name, reason: 'too-large' });
      continue;
    }
    if (PDF_EXT.test(file.name)) {
      if (await hasPdfMagic(file)) {
        pdfs.push(file);
      } else {
        rejected.push({ name: file.name, reason: 'not-pdf' });
      }
      continue;
    }
    if (IMAGE_EXT.test(file.name)) {
      images.push(file);
      continue;
    }
    rejected.push({ name: file.name, reason: 'unsupported' });
  }

  const suggestions: Suggestion[] = [];
  let showAllTools = false;

  let locked = false;
  let corruptRows: RejectedFile[] = [];
  let tier2Usable = pdfs; // tier-2 skipped/failed → fall back to count-based ranking
  // Typed results retained by tier-2 (finding 8): indexed parallel to `pdfs`,
  // empty when tier-2 did not run (skipped or timed out). The page-numbers
  // rule needs real page counts and must NEVER fire on the count-free
  // fallback path — a wrong "≥ 3 pages" guess would rank a 1-page scan into
  // a numbering tool.
  let tier2Infos: (PdfInfo | null)[] = [];
  let tier2TimedOut = false;

  if (pdfs.length > 0 && pdfs.length <= TIER2_MAX_FILES && pdfs.every((f) => f.size <= TIER2_MAX_BYTES)) {
    const states = await Promise.all(
      pdfs.map(async (file) => {
        try {
          const info = await withTimeout(loadPdfInfo(await bytesOf(file)), TIER2_TIMEOUT_MS);
          return { status: 'loaded' as const, info };
        } catch (err) {
          if (err instanceof TimeoutError) return { status: 'timeout' as const, info: null };
          if (isEncryptedError(err)) return { status: 'locked' as const, info: null };
          return { status: 'corrupt' as const, info: null };
        }
      }),
    );
    tier2Infos = states.map((s) => s.info);
    if (states.some((s) => s.status === 'timeout')) {
      // A timeout leaves the worker parsing (comlink has no cancel); its
      // results are dropped but tier-1 ranking below still applies.
      tier2TimedOut = true;
    } else {
      locked = states.some((s) => s.status === 'locked');
      corruptRows = states.flatMap((state, i) =>
        state.status === 'corrupt' ? [{ name: pdfs[i].name, reason: 'corrupt' as const }] : [],
      );
      tier2Usable = pdfs.filter((_, i) => states[i].status !== 'corrupt');
    }
  }

  if (locked) {
    suggestions.push({
      slug: 'encrypt',
      mode: 'decrypt',
      reasonKey: 'home.reason_decrypt',
      ...(files.length > 1 && { partial: true }),
    });
  }
  if (tier2Usable.length >= 2) {
    // Merge only: compress is single-file, so ranking it for a multi-PDF set
    // made the sheet route N files into a tool that silently keeps just the
    // first (which one is ambiguous anyway). Single-PDF sets still rank
    // compress below — there the target is unambiguous.
    suggestions.push({ slug: 'merge', reasonKey: 'home.reason_merge' });
  } else if (tier2Usable.length === 1) {
    suggestions.push({
      slug: 'compress',
      reasonKey: 'home.reason_compress',
      ...(files.length > 1 && { partial: true }),
    });
    // Watermark ranks below compress for a single usable UNLOCKED pdf
    // (v0.8.0) — a locked file goes to decrypt first, never to stamping.
    if (!locked) {
      suggestions.push({
        slug: 'watermark',
        reasonKey: 'home.reason_watermark',
        ...(files.length > 1 && { partial: true }),
      });
      // Page numbers ranks below watermark and needs REAL page counts
      // (finding 8): only when tier-2 actually ran (no timeout, no cap
      // skip) AND the parsed count is ≥ 3. Never on the fallback path.
      if (!tier2TimedOut && tier2Infos.length > 0) {
        const idx = pdfs.indexOf(tier2Usable[0]);
        const info = idx >= 0 ? tier2Infos[idx] : null;
        if (info && info.numPages >= 3) {
          suggestions.push({
            slug: 'page-numbers',
            reasonKey: 'home.reason_page_numbers',
            ...(files.length > 1 && { partial: true }),
          });
        }
      }
    }
    if (!locked && images.length === 0) showAllTools = true;
  }

  if (images.length > 0) {
    suggestions.push({ slug: 'img-to-pdf', reasonKey: 'home.reason_img_to_pdf' });
  }

  return { suggestions, showAllTools, rejected: [...rejected, ...corruptRows] };
}
