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

async function qpdf(): Promise<QpdfModule> {
  if (!modPromise) {
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
    const code = mod.callMain(args(inP, outP));
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
    const code = mod.callMain(['--check', inP]);
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
