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

async function runQpdfFile(input: Uint8Array, args: (inP: string, outP: string) => string[]): Promise<Uint8Array> {
  const mod = await qpdf();
  const inP = tmp('in.pdf');
  const outP = tmp('out.pdf');
  mod.FS.writeFile(inP, input);
  try {
    const code = mod.callMain(args(inP, outP));
    if (code !== 0 && code !== undefined) throw new Error(`qpdf exit ${code}`);
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
