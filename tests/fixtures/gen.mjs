import { PDFDocument, StandardFonts } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function makePdf(pages, label, seedLines) {
  const doc = await PDFDocument.create();
  doc.setTitle(`pdftoolkit-fixture-${label}`);
  doc.setCreator('pdftoolkit-gen');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`PDFTOOLKIT FIXTURE ${label} — page ${p}/${pages}`, {
      x: 48,
      y: 800,
      size: 13,
      font,
    });
    for (let i = 0; i < seedLines; i += 1) {
      page.drawText(
        `Line ${i + 1}: The quick brown fox jumps over the lazy dog. 0123456789. `.repeat(4),
        { x: 48, y: Math.max(40, 770 - i * 11), size: 8, font },
      );
    }
  }
  return doc.save({ useObjectStreams: false });
}

const small = await makePdf(2, '1mb', 40);
const medium = await makePdf(40, '10mb', 60);

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'fixture-1mb.pdf'), small);
writeFileSync(join(here, 'fixture-10mb.pdf'), medium);

// Locked variant of the 2-page fixture for the home suggestion-sheet e2e:
// encrypted with qpdf-wasm exactly like src/engine/qpdf.ts encryptPdf does.
async function encryptFixture(bytes) {
  const { default: create } = await import('@neslinesli93/qpdf-wasm');
  const inst = await create({ noInitialRun: true });
  inst.FS.writeFile('/tmp/locked-in.pdf', bytes);
  inst.callMain(['--encrypt', 'pdftoolkit', 'pdftoolkit', '256', '--', '/tmp/locked-in.pdf', '/tmp/locked-out.pdf']);
  const out = inst.FS.readFile('/tmp/locked-out.pdf').slice();
  try { inst.FS.unlink('/tmp/locked-in.pdf'); } catch { /* noop */ }
  try { inst.FS.unlink('/tmp/locked-out.pdf'); } catch { /* noop */ }
  return out;
}
const locked = await encryptFixture(small);
writeFileSync(join(here, 'fixture-locked.pdf'), locked);

// Small solid-color PNG for the image → img-to-pdf suggestion flow.
// Same pure-node PNG writer approach as scripts/gen-icons.mjs.
function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      raw[o] = 0x4f; raw[o + 1] = 0x46; raw[o + 2] = 0xe5;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
writeFileSync(join(here, 'fixture-photo.png'), makePng(64, 48));

console.log(
  JSON.stringify({
    'fixture-1mb.pdf': small.length,
    'fixture-10mb.pdf': medium.length,
    'fixture-locked.pdf': locked.length,
    'fixture-photo.png': makePng(64, 48).length,
  }),
);

// Nightly-only 100MB branch. PR never runs this: default
// `node tests/fixtures/gen.mjs` stops above. CI nightly opts in via
// `node tests/fixtures/gen.mjs --large` (or MATRIX_100MB=1) and then runs
// the 100MB matrix tier. ~4500 pages x 500 seed lines ≈ 100MB given the
// measured ~23KB/page at 10p x 500l. The matrix spec expects NIGHTLY_PAGES
// below to equal LARGE_PAGES here — keep them in sync.
const LARGE_PAGES = 4500;
const LARGE_LINES = 500;
const wantLarge =
  process.argv.includes('--large') || process.env.MATRIX_100MB === '1';
if (wantLarge) {
  const large = await makePdf(LARGE_PAGES, '100mb', LARGE_LINES);
  writeFileSync(join(here, 'fixture-100mb.pdf'), large);
  console.log(JSON.stringify({ 'fixture-100mb.pdf': large.length }));
}
