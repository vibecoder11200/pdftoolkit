// qpdf-wasm adapter — Worker-only. Lazy import keeps the main bundle free
// of the 1.33MB wasm until an encrypt/compress/decrypt call runs.
// Spike S1: encrypt 256 ships by default; 128 fallback MUST use --use-aes=y
// (bare 128 is RC4 and qpdf >= 12 refuses it without --allow-weak-crypto).
// Spike S4: single-thread Emscripten build, no COOP/COEP needed.

import { PDFDocument } from 'pdf-lib';

type QpdfModule = {
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
  };
  callMain: (args: string[]) => number;
};

let modPromise: Promise<QpdfModule> | null = null;

/*
 * Phase-8 diagnostics: qpdf-wasm routes its diagnostics (errors/warnings)
 * through console.error — the Emscripten print hooks do NOT fire (spike
 * 2026-11-13, scripts/spike-qpdf-diag.mjs + temp channel probe). Capture
 * works by arming a sink around callMain. Because the sink AND the MEMFS
 * are module-global, ALL qpdf access is serialized through a promise-chain
 * lock — concurrent operations cannot steal each other's logs or files.
 */
const lineSink: string[] = [];
let captureArmed = false;
let origConsoleError: ((...a: unknown[]) => void) | null = null;
let lockChain: Promise<unknown> = Promise.resolve();

function withQpdfLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => undefined);
  return run;
}

function installConsoleCapture(): void {
  if (origConsoleError) return;
  origConsoleError = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    if (captureArmed) {
      lineSink.push(a.map((x) => String(x)).join(' '));
      return;
    }
    origConsoleError!(...a);
  };
}

async function callCaptured(args: string[]): Promise<{ code: number | undefined; lines: string[] }> {
  const mod = await qpdf();
  return withQpdfLock(async () => {
    installConsoleCapture();
    captureArmed = true;
    lineSink.length = 0;
    try {
      const code = mod.callMain(args);
      return { code, lines: lineSink.splice(0) };
    } finally {
      captureArmed = false;
      lineSink.length = 0;
    }
  });
}

async function qpdf(): Promise<QpdfModule> {
  if (!modPromise) {
    installConsoleCapture(); // BEFORE instantiation: wasm glue binds console.error at create()
    modPromise = import('@neslinesli93/qpdf-wasm').then(async (m) => {
      const create = (m as unknown as { default: (opts: object) => Promise<unknown> }).default;
      const inst = (await create({ noInitialRun: true })) as {
        callMain: (args: string[]) => number;
        FS: {
          writeFile: (path: string, data: Uint8Array) => void;
          readFile: (path: string) => Uint8Array;
          unlink?: (path: string) => void;
        };
      };
      return {
        FS: {
          writeFile: inst.FS.writeFile.bind(inst.FS),
          readFile: inst.FS.readFile.bind(inst.FS),
          unlink: (inst.FS.unlink?.bind(inst.FS)) ?? (() => undefined),
        },
        callMain: inst.callMain.bind(inst),
      };
    });
  }
  return modPromise;
}

let seq = 0;
function tmp(ext: string): string {
  seq += 1;
  return `/tmp/pdftoolkit-${Date.now()}-${seq}.${ext}`;
}

interface RunQpdfOptions {
  /** Extra exit codes that still count as success (linearize tolerates 3 = warnings). */
  acceptableExit?: (code: number | undefined) => boolean;
  /** Called with the raw exit code before reading output (warning logging). */
  onExit?: (code: number | undefined) => void;
}

async function runQpdfFile(
  input: Uint8Array,
  args: (inP: string, outP: string) => string[],
  options: RunQpdfOptions = {},
): Promise<Uint8Array> {
  const mod = await qpdf();
  const inP = tmp('in.pdf');
  const outP = tmp('out.pdf');
  // Inside the try: a throwing writeFile (near-OOM) must not leak the tmp
  // name into the worker-lifetime MEMFS.
  try {
    mod.FS.writeFile(inP, input);
    // Same serialization as callCaptured: ONE callMain at a time across the
    // whole module (shared MEMFS + the console.error sink) — a concurrent
    // inspect/repair capture must not steal another op's stderr.
    const code = await withQpdfLock(() => Promise.resolve(mod.callMain(args(inP, outP))));
    const acceptable = options.acceptableExit ?? ((c: number | undefined) => c === 0 || c === undefined);
    if (!acceptable(code)) throw new Error(`qpdf exit ${code}`);
    options.onExit?.(code);
    return mod.FS.readFile(outP).slice();
  } finally {
    try { mod.FS.unlink(inP); } catch { /* noop */ }
    try { mod.FS.unlink(outP); } catch { /* noop */ }
  }
}

export async function qpdfCheck(input: Uint8Array): Promise<void> {
  const mod = await qpdf();
  const inP = tmp('in.pdf');
  mod.FS.writeFile(inP, input);
  try {
    const code = await withQpdfLock(() => Promise.resolve(mod.callMain(['--check', inP])));
    if (code !== 0 && code !== undefined) throw new Error(`qpdf --check exit ${code}`);
  } finally {
    try { mod.FS.unlink(inP); } catch { /* noop */ }
  }
}

export async function compressVectorPack(input: Uint8Array): Promise<Uint8Array> {
  return runQpdfFile(input, (i, o) => ['--object-streams=generate', '--', i, o]);
}

/*
 * Linearizes for fast web view (first page renders before the whole file
 * downloads). Exit-code semantics chosen here deliberately (red-team #14):
 * qpdf exits 3 when it emitted warnings (repaired xref, recovered objects…)
 * while still writing valid output. We accept 0 AND 3 for linearize — a
 * repaired file is exactly the case users need linearization for — and log
 * the warning rather than masking it globally with --warning-exit-0 (that
 * flag would also silence real warnings for compress/encrypt).
 *
 * Exported for tests: the wasm build empirically escalates most repairable
 * xref damage to exit 2, so the 0/3 boundary is unit-tested on this seam
 * (tests/linearize.spec.ts) instead of through a synthetic warning file.
 */
export function isLinearizeAcceptableExit(code: number | undefined): boolean {
  return code === 0 || code === 3 || code === undefined;
}

export async function linearizePdf(input: Uint8Array): Promise<Uint8Array> {
  const out = await runQpdfFile(input, (i, o) => ['--linearize', '--', i, o], {
    acceptableExit: isLinearizeAcceptableExit,
    onExit: (code) => {
      if (code === 3) console.warn('[linearize] qpdf exited 3 (warnings) — output kept');
    },
  });
  if (out.byteLength === 0) throw new Error('qpdf linearize produced no output');
  return out;
}

export async function encryptPdf(
  input: Uint8Array,
  userPass: string,
  ownerPass: string,
  bits: 128 | 256 = 256,
): Promise<Uint8Array> {
  const enc =
    bits === 256
      ? ['--encrypt', userPass, ownerPass, '256', '--']
      : ['--encrypt', userPass, ownerPass, '128', '--use-aes=y', '--'];
  return runQpdfFile(input, (i, o) => [...enc.slice(0, -1), '--', i, o]);
}

export async function decryptPdf(input: Uint8Array, password: string): Promise<Uint8Array> {
  const out = await runQpdfFile(input, (i, o) => [`--password=${password}`, '--decrypt', '--', i, o]);
  await PDFDocument.load(out, { ignoreEncryption: false });
  return out;
}

/*
 * Redact finalize tail (v0.9.0 phase 2). Both are INTERNAL helpers of
 * redactFinalize (pdf-lib.ts) — deliberately NOT wired through client.ts, so
 * no caller can order a rewrite without the verify tail (invariant 2).
 *
 * qpdfRewrite: plain traversal-based rewrite — the "orphan GC" pass. qpdf
 * drops every UNREFERENCED object (superseded incremental-revision leftovers
 * the pdf-lib whole-file parser would re-emit); residue inside still-
 * REFERENCED objects survives it and is caught by the decompressed byte-scan.
 * Exit policy mirrors linearize (0|3 acceptable — damaged old scans that most
 * need redaction often exit 3 with repair warnings); exit 2 → the file cannot
 * be safely rewritten → typed refusal upstream.
 */
export class QpdfRewriteRefusedError extends Error {
  constructor(code: number | undefined) {
    super(`qpdf rewrite refused the file (exit ${code}).`);
    this.name = 'QpdfRewriteRefusedError';
  }
}

export async function qpdfRewrite(input: Uint8Array): Promise<Uint8Array> {
  const out = await runQpdfFile(input, (i, o) => ['--', i, o], {
    acceptableExit: (c) => c === 0 || c === 3 || c === undefined,
    onExit: (code) => {
      if (code === 3) console.warn('[redact] qpdf rewrite exited 3 (warnings) — output kept');
    },
  });
  if (out.byteLength === 0) throw new QpdfRewriteRefusedError(-1);
  return out;
}

/** The verification form: streams decompressed, object streams disabled —
 * what the scoped byte-scan runs over (qpdf flate-compresses by DEFAULT, so
 * a scan on the shipped form sees nothing — red-team finding 3). */
export async function qpdfCanonicalUncompress(input: Uint8Array): Promise<Uint8Array> {
  return runQpdfFile(input, (i, o) => ['--stream-data=uncompress', '--object-streams=disable', '--', i, o]);
}

// ---------------------------------------------------------------------------
// Phase-8 diagnostics + best-effort repair (plan 261112-0955).
// DELIBERATELY SEPARATE from qpdfRewrite (the internal redact tail): repair
// is a user-facing low-level helper with its own validation layer upstream;
// qpdfRewrite stays unwired on the client surface.
// Spike matrix (plans/.../reports/qpdf-diagnostic-spike.md): --check exits
// 0 healthy/garbage-appended, 2 truncated/startxref-corrupt/encrypted-no-
// password/not-a-pdf; plain rewrite produces output ONLY on the exit-0
// class — exit 2 yields NO output (repair refuses; never partial bytes).
// ---------------------------------------------------------------------------

export interface QpdfRawResult {
  exitCode: number;
  /** Raw captured stderr lines (sanitize upstream before display). */
  lines: string[];
}

/** Read-only --check with captured diagnostics. */
export async function qpdfInspectRaw(input: Uint8Array): Promise<QpdfRawResult> {
  const mod = await qpdf();
  const inP = tmp('in.pdf');
  try {
    // writeFile INSIDE the try: a throwing (near-OOM) write must not leak
    // the tmp name into the worker-lifetime MEMFS (runQpdfFile discipline).
    mod.FS.writeFile(inP, input);
    const { code, lines } = await callCaptured(['--check', inP]);
    return { exitCode: code ?? 0, lines };
  } finally {
    try { mod.FS.unlink(inP); } catch { /* noop */ }
  }
}

export class QpdfRepairRefusedError extends Error {
  constructor(
    readonly exitCode: number,
    readonly lines: string[],
  ) {
    super('qpdf repair refused the input (exit ' + exitCode + ')');
    this.name = 'QpdfRepairRefusedError';
  }
}

/**
 * Best-effort rewrite into NEW bytes. Exit 2/1 means qpdf produced NO
 * output (spike: truncated/corrupt-xref/encrypted inputs) → typed refusal,
 * nothing returned. Exit 3 (warnings) keeps the output and surfaces the
 * lines. An encrypted input needs the password option (never stripped).
 */
export async function qpdfRepairRaw(
  input: Uint8Array,
  password?: string,
): Promise<QpdfRawResult & { bytes: Uint8Array }> {
  const mod = await qpdf();
  const inP = tmp('in.pdf');
  const outP = tmp('out.pdf');
  try {
    // writeFile INSIDE the try (same MEMFS-leak discipline as runQpdfFile).
    mod.FS.writeFile(inP, input);
    // --decrypt when a password is supplied: the caller-provided password IS
    // the explicit option to produce an OPENABLE (decrypted) output — qpdf
    // otherwise preserves encryption and the result stays locked.
    const args = password ? ['--password=' + password, '--decrypt', '--', inP, outP] : ['--', inP, outP];
    const { code, lines } = await callCaptured(args);
    const c = code ?? 0;
    if (c !== 0 && c !== 3) throw new QpdfRepairRefusedError(c, lines);
    let out: Uint8Array;
    try {
      out = mod.FS.readFile(outP).slice();
    } catch {
      throw new QpdfRepairRefusedError(c, lines);
    }
    if (out.byteLength === 0) throw new QpdfRepairRefusedError(c, lines);
    return { bytes: out, exitCode: c, lines };
  } finally {
    try { mod.FS.unlink(inP); } catch { /* noop */ }
    try { mod.FS.unlink(outP); } catch { /* noop */ }
  }
}
