/*
 * Phase 3 batch-name validation (least-privilege delivery). A multi-output
 * batch writes siblings into ONE user-picked directory; every name crossing
 * that boundary must be a plain basename the OS accepts and the batch can
 * resolve without clobbering a sibling target.
 *
 * Rules (phase-3 acceptance): no absolute, traversal, separators, control
 * chars, Windows reserved names, invalid filesystem chars, trailing
 * dot/space (Windows silently strips those — a target that "moves" is a
 * collision we refuse to create), or >240-char basenames. In-batch
 * case-insensitive duplicate targets get a deterministic `-2/-3...` suffix
 * that itself skips already-taken targets.
 */

export type NameError =
  | 'empty'
  | 'absolute'
  | 'separator'
  | 'control'
  | 'invalid-char'
  | 'reserved'
  | 'trailing-dot-space'
  | 'too-long';

export type NameResolution =
  | { index: number; ok: true; final: string }
  | { index: number; ok: false; error: NameError };

/** Windows reserved device names — reserved with or without extension. */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

const INVALID_CHARS = /[<>:"|?*]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_BASENAME = 240;

/** First rule violation in the name, or null when the basename is usable. */
function nameError(name: string): NameError | null {
  if (name.length === 0) return 'empty';
  if (name === '.' || name === '..') return 'reserved';
  // Absolute: drive-letter (C:\x, C:/x) or leading separator.
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('/') || name.startsWith('\\')) return 'absolute';
  if (name.includes('/') || name.includes('\\')) return 'separator';
  if (CONTROL.test(name)) return 'control';
  if (INVALID_CHARS.test(name)) return 'invalid-char';
  const stem = name.replace(/\.[^.]*$/, ''); // strip the LAST extension
  if (RESERVED.has(stem.toUpperCase())) return 'reserved';
  if (/[. ]$/.test(name)) return 'trailing-dot-space';
  if (name.length > MAX_BASENAME) return 'too-long';
  return null;
}

/**
 * Resolve a batch of target names: invalid ones are refused (caller skips
 * them — the batch continues), case-insensitive duplicates get the first
 * free `-N` suffix (checked against every final name in this batch, so
 * `['a-2.pdf', 'a.pdf', 'a.pdf']` yields `a-2.pdf, a.pdf, a-3.pdf`).
 */
export function resolveBatchNames(names: string[]): NameResolution[] {
  const taken = new Set<string>();
  return names.map((raw, index) => {
    const error = nameError(raw);
    if (error) return { index, ok: false as const, error };
    // Suffix goes before the extension; ext '' when there is none.
    const dot = raw.lastIndexOf('.');
    const stem = dot > 0 ? raw.slice(0, dot) : raw;
    const ext = dot > 0 ? raw.slice(dot) : '';
    let candidate = raw;
    let n = 1;
    while (taken.has(candidate.toLowerCase())) {
      n += 1;
      candidate = `${stem}-${n}${ext}`;
      // Suffix overflow: keep counting (stem has no length cap of its own
      // beyond MAX_BASENAME, and a suffix bump only changes digits).
    }
    taken.add(candidate.toLowerCase());
    return { index, ok: true as const, final: candidate };
  });
}
