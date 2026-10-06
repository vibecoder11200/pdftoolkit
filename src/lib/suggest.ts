import { engine } from '../engine/client';
import type { PdfInfo } from '../engine/pdf-lib';
import { MAX_FILE_BYTES, sniffHeicName } from './file-accept';

export type SuggestSlug = 'merge' | 'compress' | 'img-to-pdf' | 'encrypt';

export interface Suggestion {
  slug: SuggestSlug;
  /** Only set for locked PDFs: land on the encrypt tool in decrypt mode. */
  mode?: 'decrypt';
  reasonKey: string;
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

function isEncryptedError(err: unknown): boolean {
  // Comlink rethrows worker errors preserving name/message; accept either.
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

  if (pdfs.length > 0 && pdfs.length <= TIER2_MAX_FILES && pdfs.every((f) => f.size <= TIER2_MAX_BYTES)) {
    const states = await Promise.all(
      pdfs.map(async (file) => {
        try {
          await withTimeout(loadPdfInfo(await bytesOf(file)), TIER2_TIMEOUT_MS);
          return 'loaded' as const;
        } catch (err) {
          if (err instanceof TimeoutError) return 'timeout' as const;
          if (isEncryptedError(err)) return 'locked' as const;
          return 'corrupt' as const;
        }
      }),
    );
    if (!states.some((s) => s === 'timeout')) {
      // A timeout leaves the worker parsing (comlink has no cancel); its
      // results are dropped but tier-1 ranking below still applies.
      locked = states.includes('locked');
      corruptRows = states.flatMap((state, i) =>
        state === 'corrupt' ? [{ name: pdfs[i].name, reason: 'corrupt' as const }] : [],
      );
      tier2Usable = pdfs.filter((_, i) => states[i] !== 'corrupt');
    }
  }

  if (locked) {
    suggestions.push({ slug: 'encrypt', mode: 'decrypt', reasonKey: 'home.reason_decrypt' });
  }
  if (tier2Usable.length >= 2) {
    suggestions.push({ slug: 'merge', reasonKey: 'home.reason_merge' });
    suggestions.push({ slug: 'compress', reasonKey: 'home.reason_compress' });
  } else if (tier2Usable.length === 1) {
    suggestions.push({ slug: 'compress', reasonKey: 'home.reason_compress' });
    if (!locked && images.length === 0) showAllTools = true;
  }

  if (images.length > 0) {
    suggestions.push({ slug: 'img-to-pdf', reasonKey: 'home.reason_img_to_pdf' });
  }

  return { suggestions, showAllTools, rejected: [...rejected, ...corruptRows] };
}
