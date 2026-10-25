import { PDFDocument, PDFName, PDFHexString, PDFString, StandardFonts } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import fontkit from '@pdf-lib/fontkit';

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

const small = await makePdf(2, 'small', 40);
const medium = await makePdf(40, 'medium', 60);

// v0.8.0 fixtures: geometry matrix + rotated + pagenums (tests/watermark-
// engine.spec.ts / tests/page-numbers-engine.spec.ts / phase-5 e2e).
// GEOM_CONFIGS encodes the per-page rotation × box config the specs expect —
// keep in sync with the specs' expected geometry.
const GEOM_CONFIGS = [
  { rotate: 0, crop: false },
  { rotate: 0, crop: true },
  { rotate: 90, crop: false },
  { rotate: 90, crop: true },
  { rotate: 180, crop: false },
  { rotate: 180, crop: true },
  { rotate: 270, crop: false },
  { rotate: 270, crop: true },
];
async function makeGeomPdf() {
  const doc = await PDFDocument.create();
  doc.setTitle('pdftoolkit-fixture-geom');
  doc.setCreator('pdftoolkit-gen');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, cfg] of GEOM_CONFIGS.entries()) {
    const page = doc.addPage([595, 842]);
    page.drawText(`GEOM p${i + 1} r${cfg.rotate} ${cfg.crop ? 'crop' : 'media'}`, {
      x: 48, y: 800, size: 13, font,
    });
    if (cfg.rotate !== 0) {
      page.setRotation({ type: 'degrees', angle: cfg.rotate });
    }
    if (cfg.crop) {
      page.setCropBox(40, 60, 515, 722);
    }
  }
  return doc.save({ useObjectStreams: false });
}
const geom = await makeGeomPdf();
writeFileSync(join(here, 'fixture-geom.pdf'), geom);

const rotated = await makePdf(4, 'rotated', 3);
{
  const doc = await PDFDocument.load(rotated);
  for (const [i, angle] of [0, 90, 180, 270].entries()) {
    if (angle !== 0) doc.getPage(i).setRotation({ type: 'degrees', angle });
  }
  writeFileSync(join(here, 'fixture-rotated.pdf'), await doc.save({ useObjectStreams: false }));
}

const pagenums = await makePdf(5, 'pagenums', 3);
writeFileSync(join(here, 'fixture-pagenums.pdf'), pagenums);

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'fixture-small.pdf'), small);
writeFileSync(join(here, 'fixture-medium.pdf'), medium);

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

// Vietnamese AcroForm fixture (phase 6a): one page, two text fields with
// diacritic labels — "Họ và tên" (single-line) and "Địa chỉ" (multiline).
// Labels on the page are drawn with subset Roboto (WinAnsi standard fonts
// cannot encode diacritics); field names stay ASCII like real-world forms,
// while /TU tooltips carry the Vietnamese label the fill tool surfaces.
// Fields use explicit DA font size 12 — pdf-lib's AUTO-size multiline
// appearance path is broken (pdf-lib#1581 class), explicit size is not.
const ROBOTO_TTF = join(here, '..', '..', 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
if (!existsSync(ROBOTO_TTF)) {
  throw new Error(
    `[gen.mjs] missing ${ROBOTO_TTF} — the committed Roboto Regular asset is required for the VN form fixture`,
  );
}
async function makeFormVn() {
  const doc = await PDFDocument.create();
  doc.setTitle('pdftoolkit-fixture-form-vn');
  doc.setCreator('pdftoolkit-gen');
  doc.registerFontkit(fontkit);
  const roboto = await doc.embedFont(readFileSync(ROBOTO_TTF), { subset: true });
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();

  page.drawText('Họ và tên:', { x: 48, y: 782, size: 12, font: roboto });
  const hoTen = form.createTextField('ho_ten');
  hoTen.addToPage(page, { x: 140, y: 776, width: 240, height: 24 });
  hoTen.setFontSize(12);
  hoTen.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Họ và tên'));

  page.drawText('Địa chỉ:', { x: 48, y: 726, size: 12, font: roboto });
  const diaChi = form.createTextField('dia_chi');
  diaChi.enableMultiline();
  diaChi.addToPage(page, { x: 140, y: 640, width: 280, height: 72 });
  diaChi.setFontSize(12);
  diaChi.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Địa chỉ'));

  return doc.save({ useObjectStreams: false });
}
const formVn = await makeFormVn();
writeFileSync(join(here, 'form-vn.pdf'), formVn);

// Vietnamese full-type AcroForm fixture (phase 6b): every fillable field type
// on one page — single-line text, multiline text (explicit size), multiline
// text with a TRUE-AUTO /DA (`0 Tf`, the upstream pdf-lib#1581 blowup case),
// readonly text, checkbox, 2-option radio group, 5-option radio group (the
// UI renders >4 options as a dropdown-style select), and a dropdown with VN
// option labels. Field names stay ASCII like real-world forms; /TU tooltips
// carry the Vietnamese labels the fill tool surfaces.
async function makeFormVnFull() {
  const { PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFTextField } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle('pdftoolkit-fixture-form-vn-full');
  doc.setCreator('pdftoolkit-gen');
  doc.registerFontkit(fontkit);
  const roboto = await doc.embedFont(readFileSync(ROBOTO_TTF), { subset: true });
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  const label = (text, x, y) => page.drawText(text, { x, y, size: 11, font: roboto });

  label('Họ và tên:', 48, 792);
  const hoTen = form.createTextField('ho_ten');
  hoTen.addToPage(page, { x: 140, y: 786, width: 240, height: 24 });
  hoTen.setFontSize(12);
  hoTen.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Họ và tên'));

  label('Địa chỉ:', 48, 748);
  const diaChi = form.createTextField('dia_chi');
  diaChi.enableMultiline();
  diaChi.addToPage(page, { x: 140, y: 648, width: 280, height: 72 });
  diaChi.setFontSize(12);
  diaChi.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Địa chỉ'));

  label('Ghi chú (auto):', 48, 604);
  const ghiChu = form.createTextField('ghi_chu');
  ghiChu.enableMultiline();
  ghiChu.addToPage(page, { x: 140, y: 532, width: 280, height: 72 });
  // True-AUTO /DA: size 0 tells the appearance provider to compute the size.
  // pdf-lib's addToPage pre-writes a computed size (the 62pt-in-72pt-box bug
  // class), so overwrite with the canonical AUTO marker a foreign producer
  // would emit — the 6b mitigation must force an explicit fitting size.
  // markAsClear: enableMultiline set the dirty flag, and save()'s default
  // appearance pass would otherwise regenerate the field and clobber the
  // 0 Tf marker back to its computed size (markAsClean is runtime-public).
  ghiChu.acroField.setDefaultAppearance('0 0 0 rg /Helvetica 0 Tf');
  ghiChu.markAsClean();
  ghiChu.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Ghi chú'));

  label('Mã hồ sơ (chỉ đọc):', 48, 496);
  const maHoSo = form.createTextField('ma_ho_so');
  maHoSo.addToPage(page, { x: 210, y: 490, width: 160, height: 22 });
  maHoSo.setText('FT-2026-VN');
  maHoSo.setFontSize(12);
  maHoSo.enableReadOnly();
  maHoSo.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Mã hồ sơ'));

  label('Đồng ý điều khoản:', 48, 452);
  const dongY = form.createCheckBox('dong_y');
  dongY.addToPage(page, { x: 200, y: 444, width: 20, height: 20 });
  dongY.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Đồng ý điều khoản'));

  label('Giới tính:', 48, 408);
  const gioiTinh = form.createRadioGroup('gioi_tinh');
  gioiTinh.addOptionToPage('nam', page, { x: 150, y: 400, width: 16, height: 16 });
  gioiTinh.addOptionToPage('nu', page, { x: 190, y: 400, width: 16, height: 16 });
  gioiTinh.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Giới tính'));

  label('Khu vực (5 lựa chọn):', 48, 368);
  const khuVuc = form.createRadioGroup('khu_vuc');
  for (const [i, opt] of ['mb', 'mt', 'mn', 'tb', 'tn'].entries()) {
    khuVuc.addOptionToPage(opt, page, { x: 220 + i * 32, y: 360, width: 16, height: 16 });
  }
  khuVuc.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Khu vực'));

  label('Nghề nghiệp:', 48, 324);
  const nghe = form.createDropdown('nghe');
  nghe.addOptions(['Kế toán', 'Kỹ sư', 'Bác sĩ', 'Khác']);
  nghe.addToPage(page, { x: 150, y: 316, width: 180, height: 24 });
  nghe.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Nghề nghiệp'));

  // Structure sanity — the fixture must exercise every 6b type.
  const types = form.getFields().map((f) => f.constructor.name);
  for (const cls of [PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown]) {
    if (!types.includes(cls.name)) throw new Error(`[gen.mjs] form-vn-full missing ${cls.name}`);
  }
  return doc.save({ useObjectStreams: false });
}
const formVnFull = await makeFormVnFull();
writeFileSync(join(here, 'form-vn-full.pdf'), formVnFull);

// Same form with an invisible /FT /Sig field appended (same low-level shape
// as src/lib/sign.ts): exercises the R15 signed-PDF warnings. No real
// cryptographic signature is needed — detection is structural.
{
  const { PDFDict, PDFArray } = await import('pdf-lib');
  const doc = await PDFDocument.load(formVnFull);
  const sigRef = doc.context.nextRef();
  doc.context.assign(
    sigRef,
    doc.context.obj({ FT: PDFName.of('Sig'), T: PDFString.of('Sig1'), F: 4 }),
  );
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acroForm.lookup(PDFName.of('Fields'), PDFArray).push(sigRef);
  writeFileSync(join(here, 'form-vn-signed.pdf'), await doc.save({ useObjectStreams: false }));
}

// XFA variant: the catalog /AcroForm carries /XFA — the fill tool must refuse
// before any getForm() call (pdf-lib strips /XFA on form access). pdf-lib's
// save() silently drops /XFA, so serialize the mutated context directly via
// the runtime-only writer (deep import; not on the public export surface).
{
  const { PDFDict } = await import('pdf-lib');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { default: PDFStreamWriter } = require('pdf-lib/cjs/core/writers/PDFStreamWriter.js');
  const doc = await PDFDocument.load(formVnFull);
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acroForm.set(PDFName.of('XFA'), PDFHexString.fromText('<xdp/><ref/>'));
  const xfaBytes = await PDFStreamWriter.forContext(doc.context, 50).serializeToBuffer();
  writeFileSync(join(here, 'form-xfa.pdf'), xfaBytes);
}

// Password-locked variant of the full form (phase 6b e2e: decrypt → fill in
// place). Same qpdf-wasm encryption as fixture-locked.pdf ('pdftoolkit').
const formVnLocked = await encryptFixture(formVnFull);
writeFileSync(join(here, 'form-vn-locked.pdf'), formVnLocked);

// PKCS#12 bundles for the real-cert signing tests (phase 5). openssl CLI is
// required (present on dev machines + ubuntu CI runners); when missing, the
// cert specs skip via a fixture-existence check instead of failing npm test.
const CERT_PASSWORD = 'cert-pass';
const subj = (cn) => ['-subj', `/CN=${cn}/O=pdftoolkit/C=VN`];
const fx = (f) => join(here, f);
function openssl(...args) {
  const r = spawnSync(
    'openssl',
    args.map((a) => (typeof a === 'string' && (a.startsWith('cert-') || a.startsWith('fixture-')) ? fx(a) : a)),
    { encoding: 'buffer' },
  );
  if (r.status !== 0) {
    throw new Error(`openssl ${args[0]} exit ${r.status}: ${r.stderr?.toString()}`);
  }
}
function genKey(keyFile, kind) {
  if (kind.type === 'ec') {
    openssl('ecparam', '-name', kind.curve, '-genkey', '-noout', '-out', keyFile);
  } else {
    openssl('genrsa', '-out', keyFile, kind.bits);
  }
}
function certFrom(keyFile, cn, crtFile) {
  openssl('req', '-x509', '-new', '-key', keyFile, ...subj(cn), '-days', '365', '-nodes', '-out', crtFile);
}
function p12Export(outFile, keyFile, inPem) {
  openssl('pkcs12', '-export', '-out', outFile, '-inkey', keyFile, '-in', inPem, '-passout', `pass:${CERT_PASSWORD}`);
}
try {
  // Simple self-signed: RSA-2048 and EC P-256.
  for (const [name, kind] of [
    ['cert-rsa', { type: 'rsa', bits: 2048 }],
    ['cert-ec', { type: 'ec', curve: 'prime256v1' }],
  ]) {
    genKey(`${name}.key`, kind);
    certFrom(`${name}.key`, `${name} Test`, `${name}.crt`);
    p12Export(`fixture-${name}.p12`, `${name}.key`, `${name}.crt`);
  }
  // 3-cert chain: root → intermediate → leaf (RSA).
  {
    const n = 'cert-chain';
    genKey(`${n}-root.key`, { type: 'rsa', bits: 3072 });
    certFrom(`${n}-root.key`, `${n} Root`, `${n}-root.crt`);
    openssl('req', '-newkey', 'rsa:3072', '-keyout', `${n}-inter.key`, '-out', `${n}-inter.csr`, '-nodes', ...subj(`${n} Intermediate`));
    openssl('x509', '-req', '-in', `${n}-inter.csr`, '-CA', `${n}-root.crt`, '-CAkey', `${n}-root.key`, '-CAcreateserial', '-out', `${n}-inter.crt`, '-days', '365');
    genKey(`${n}-leaf.key`, { type: 'rsa', bits: 2048 });
    openssl('req', '-new', '-key', `${n}-leaf.key`, '-out', `${n}-leaf.csr`, '-nodes', ...subj(`${n} Chained Leaf`));
    openssl('x509', '-req', '-in', `${n}-leaf.csr`, '-CA', `${n}-inter.crt`, '-CAkey', `${n}-inter.key`, '-CAcreateserial', '-out', `${n}-leaf.crt`, '-days', '365');
    const full = readFileSync(fx(`${n}-leaf.crt`), 'utf8') + '\n' + readFileSync(fx(`${n}-inter.crt`), 'utf8') + '\n' + readFileSync(fx(`${n}-root.crt`), 'utf8');
    writeFileSync(fx(`${n}-full.pem`), full);
    p12Export(`fixture-${n}.p12`, `${n}-leaf.key`, `${n}-full.pem`);
  }
  console.log(JSON.stringify({ P12: 'fixtures generated (openssl)' }));
} catch (e) {
  console.warn(`[gen.mjs] P12 fixtures SKIPPED (${e.message.split('\n')[0]}) — cert specs will self-skip`);
}

console.log(
  JSON.stringify({
    'fixture-small.pdf': small.length,
    'fixture-medium.pdf': medium.length,
    'fixture-locked.pdf': locked.length,
    'fixture-photo.png': makePng(64, 48).length,
    'fixture-geom.pdf': geom.length,
    'fixture-rotated.pdf': readFileSync(join(here, 'fixture-rotated.pdf')).length,
    'fixture-pagenums.pdf': pagenums.length,
    'form-vn.pdf': formVn.length,
    'form-vn-full.pdf': formVnFull.length,
    'form-vn-signed.pdf': readFileSync(join(here, 'form-vn-signed.pdf')).length,
    'form-xfa.pdf': readFileSync(join(here, 'form-xfa.pdf')).length,
    'form-vn-locked.pdf': formVnLocked.length,
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

// OCR scan fixtures (phase 4b, plan v0.4.0): image-only PDFs that look like
// phone scans — pages rendered with @napi-rs/canvas (Roboto is diacritics
// capable) at ~200/150dpi, JPEG-encoded, wrapped with pdf-lib embedJpg so the
// PDF carries NO text layer. tests/ocr-integration.spec.ts renders these back
// and OCRs them with real tesseract. Canvas is dynamically imported so the
// rest of gen.mjs never depends on it (same self-skip precedent as the P12
// fixtures above).
try {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
  if (!GlobalFonts.registerFromPath(ROBOTO_TTF, 'Roboto')) {
    throw new Error(`Roboto font could not be registered from ${ROBOTO_TTF}`);
  }

  // lines: [text, pixelSize][] — returns JPEG bytes of one rendered page.
  function renderScanPage(width, height, lines) {
    const canvas = createCanvas(width, height);
    drawScanLines(canvas.getContext('2d'), width, height, lines);
    return canvas.encode('jpeg', 0.9);
  }

  function drawScanLines(ctx, width, height, lines) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111111';
    let y = Math.round(height * 0.14);
    for (const [text, size] of lines) {
      ctx.font = `${size}px Roboto`;
      ctx.fillText(text, Math.round(width * 0.07), y);
      y += Math.round(size * 1.9);
    }
  }

  async function makeScanPdf(jpegs, title) {
    const doc = await PDFDocument.create();
    doc.setTitle(`pdftoolkit-fixture-${title}`);
    doc.setCreator('pdftoolkit-gen');
    for (const jpeg of jpegs) {
      const img = await doc.embedJpg(jpeg);
      const page = doc.addPage([595.28, 841.89]);
      page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    }
    return doc.save({ useObjectStreams: false });
  }

  // A4 at a given dpi.
  const a4 = (dpi) => [Math.round((210 / 25.4) * dpi), Math.round((297 / 25.4) * dpi)];

  // 2-page fixture: EN page 1 + VN page 2 at 200dpi (1654x2339). The spec
  // renders these back at the same dpi (scale 200/72 ≈ 1:1 pixels) and
  // asserts the searchable-PDF keywords — keep the strings in sync with
  // tests/ocr-integration.spec.ts. The line specs are hoisted so the v0.7.0
  // A/B golden-page rasters (below) render the SAME content.
  const VN_EN_LINES = [
    [
      ['Quarterly report', 64],
      ['total 42,518 items processed', 44],
      ['Regional warehouse, Building 7', 38],
      ['Revenue up 12.4 percent year over year', 38],
    ],
    [
      ['Đặng Thị Thu Lĩnh', 64],
      ['kế hoạch 2026, Hà Nội', 44],
      ['Người phối ngẫu số 7', 38],
      ['Điện thoại: 0912 345 678', 38],
    ],
  ];
  const vnEn = await makeScanPdf(
    await Promise.all(VN_EN_LINES.map((lines) => renderScanPage(...a4(200), lines))),
    'ocr-scan-vn-en',
  );
  writeFileSync(join(here, 'ocr-scan-vn-en.pdf'), vnEn);

  // 12-page fold-merge fixture: EN digits only (fast OCR), 150dpi
  // (1240x1754), a unique serial per page proving fold preserves order.
  const pages12 = [];
  for (let i = 1; i <= 12; i += 1) {
    pages12.push(
      await renderScanPage(...a4(150), [
        [`Scan page ${i} of 12`, 64],
        [`Serial: 8347${String(i).padStart(3, '0')}`, 48],
        ['pdftoolkit fixture scan', 36],
      ]),
    );
  }
  const scan12 = await makeScanPdf(pages12, 'ocr-scan-12p');
  writeFileSync(join(here, 'ocr-scan-12p.pdf'), scan12);

  // Table + heading scan fixture (v0.5.0 phase 1, red-team F13): the line-list
  // fixtures above cannot distinguish a structured-output engine (GLM-OCR
  // markdown) from plain transcription — a scan with REAL table geometry
  // (2-column x-offsets + ruled grid) and section headings is the quality
  // probe for the AI OCR verdict. Page 2 is a light skew/noise variant so the
  // verdict is not optimistic on perfectly clean renders.
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function renderTablePage(width, height, { title, sections, skewDeg = 0, noise = false, seed = 1 }) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    if (skewDeg !== 0) {
      ctx.translate(width / 2, height / 2);
      ctx.rotate((skewDeg * Math.PI) / 180);
      ctx.translate(-width / 2, -height / 2);
    }
    const x0 = Math.round(width * 0.08);
    const x1 = Math.round(width * 0.55);
    let y = Math.round(height * 0.08);
    ctx.fillStyle = '#111111';
    ctx.font = `bold ${Math.round(height * 0.027)}px Roboto`;
    ctx.fillText(title, x0, y);
    y += Math.round(height * 0.045);
    for (const section of sections) {
      ctx.font = `bold ${Math.round(height * 0.019)}px Roboto`;
      ctx.fillText(section.heading, x0, y);
      y += Math.round(height * 0.035);
      const rows = [section.header, ...section.rows];
      const rowH = Math.round(height * 0.024);
      const gridBottom = y + rows.length * rowH;
      // cell text (2 columns at fixed x-offsets) + ruled grid
      ctx.font = `${Math.round(height * 0.0165)}px Roboto`;
      for (const [i, row] of rows.entries()) {
        const cy = y + i * rowH + Math.round(rowH * 0.72);
        ctx.fillText(row[0], x0 + 8, cy);
        ctx.fillText(row[1], x1 + 8, cy);
      }
      ctx.strokeStyle = '#555555';
      ctx.lineWidth = 1;
      for (let i = 0; i <= rows.length; i += 1) {
        const gy = y + i * rowH + Math.round(rowH * 0.1);
        ctx.beginPath();
        ctx.moveTo(x0, gy);
        ctx.lineTo(x1 + Math.round(width * 0.38), gy);
        ctx.stroke();
      }
      for (const gx of [x0, x1, x1 + Math.round(width * 0.38)]) {
        ctx.beginPath();
        ctx.moveTo(gx, y + Math.round(rowH * 0.1));
        ctx.lineTo(gx, gridBottom + Math.round(rowH * 0.1));
        ctx.stroke();
      }
      y = gridBottom + Math.round(height * 0.05);
    }
    ctx.restore();
    if (noise) {
      // deterministic speckle — a phone-scan look without flaky randomness
      const rand = mulberry32(seed);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      const count = Math.round(width * height * 0.00012);
      for (let i = 0; i < count; i += 1) {
        ctx.fillRect(Math.round(rand() * width), Math.round(rand() * height), 2, 2);
      }
    }
    return canvas.encode('jpeg', 0.9);
  }

  const money = (n) => `${n.toLocaleString('vi-VN')}.000`;
  const tableRows = (prefix, start, count, base) =>
    Array.from({ length: count }, (_, i) => [`${prefix}-${String(start + i).padStart(3, '0')}`, money(base + (i * 137_000) % 9_000_000)]);

  const tableScan = await makeScanPdf(
    [
      await renderTablePage(...a4(200), {
        title: 'BÁO CÁO TỒN KHO QUÝ 3/2026',
        sections: [
          {
            heading: 'Khu vực phía Bắc',
            header: ['Mã hàng', 'Thành tiền (VND)'],
            rows: tableRows('BT', 31, 14, 12_450),
          },
          {
            heading: 'Khu vực phía Nam',
            header: ['Mã hàng', 'Thành tiền (VND)'],
            rows: tableRows('SG', 7, 10, 8_320),
          },
        ],
      }),
      await renderTablePage(...a4(200), {
        title: 'PHỤ LỤC — ĐỐI CHIẾU CÔNG NỢ',
        sections: [
          {
            heading: 'Khách hàng sỉ',
            header: ['Mã KH', 'Dư nợ (VND)'],
            rows: tableRows('KHSI', 2, 8, 45_900),
          },
        ],
        skewDeg: 0.9,
        noise: true,
        seed: 20261008,
      }),
    ],
    'ocr-scan-table',
  );
  writeFileSync(join(here, 'ocr-scan-table.pdf'), tableScan);

  // v0.7.0 phase 1 golden pages: math/LaTeX page + hostile noisy page for the
  // prompt A/B runner (src-tauri/tests/native_prompt_ab.rs). The math page
  // tests DELIMITER EMISSION ($...$ / $$...$$) with glyph-drawn math — not
  // LaTeX correctness (that is phase 4's synthetic-LaTeX concern). The noisy
  // page (low contrast + skew + speckle) is the hallucination/regression
  // guard. Ground truth transcriptions live in tests/fixtures/ocr-ab-truth/
  // (COMMITTED) — keep the strings in sync with what is drawn here.
  function drawMathPage(ctx, width, height) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    const x0 = Math.round(width * 0.08);
    let y = Math.round(height * 0.09);
    ctx.fillStyle = '#111111';
    ctx.font = `bold ${Math.round(height * 0.032)}px Roboto`;
    ctx.fillText('CÔNG THỨC TOÁN HỌC', x0, y);
    y += Math.round(height * 0.05);
    ctx.font = `bold ${Math.round(height * 0.022)}px Roboto`;
    ctx.fillText('Tổng và tích phân', x0, y);
    y += Math.round(height * 0.04);
    ctx.font = `${Math.round(height * 0.02)}px Roboto`;
    for (const line of [
      'Tổng: ∑ i² với i chạy từ 1 đến n',
      'Tích phân: ∫ x dx từ 0 đến 1 bằng 1/2',
      'Căn bậc hai: √2 ≈ 1,414 và √3 ≈ 1,732',
      'Định lý Pytago: a² + b² = c²',
      'The integral of x dx from 0 to 1 equals one half.',
    ]) {
      ctx.fillText(line, x0, y);
      y += Math.round(height * 0.036);
    }
    // Display math: (a + b)/(c + d) as a stacked fraction with a rule.
    y += Math.round(height * 0.012);
    const cx = Math.round(width * 0.5);
    ctx.textAlign = 'center';
    ctx.fillText('a + b', cx, y);
    y += Math.round(height * 0.012);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = Math.max(2, Math.round(height * 0.0022));
    ctx.beginPath();
    ctx.moveTo(cx - Math.round(width * 0.06), y);
    ctx.lineTo(cx + Math.round(width * 0.06), y);
    ctx.stroke();
    y += Math.round(height * 0.032);
    ctx.fillText('c + d', cx, y);
    ctx.textAlign = 'left';
    y += Math.round(height * 0.055);
    ctx.font = `bold ${Math.round(height * 0.02)}px Roboto`;
    ctx.fillText('Bảng 1. Giá trị căn bậc hai', x0, y);
    y += Math.round(height * 0.038);
    const rows = [
      ['x', 'f(x)'],
      ['1', '1,0000'],
      ['2', '1,4142'],
      ['3', '1,7321'],
    ];
    const x1 = Math.round(width * 0.4);
    const rowH = Math.round(height * 0.03);
    ctx.font = `${Math.round(height * 0.019)}px Roboto`;
    for (const [i, row] of rows.entries()) {
      const cy = y + i * rowH;
      ctx.fillText(row[0], x0 + 8, cy);
      ctx.fillText(row[1], x1 + 8, cy);
    }
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;
    for (let i = 0; i <= rows.length; i += 1) {
      const gy = y + i * rowH;
      ctx.beginPath();
      ctx.moveTo(x0, gy);
      ctx.lineTo(x1 + Math.round(width * 0.25), gy);
      ctx.stroke();
    }
    for (const gx of [x0, x1, x1 + Math.round(width * 0.25)]) {
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + rows.length * rowH);
      ctx.stroke();
    }
  }

  function drawNoisyPage(ctx, width, height) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate((1.6 * Math.PI) / 180);
    ctx.translate(-width / 2, -height / 2);
    ctx.fillStyle = '#8a8a8a'; // low contrast — the hallucination probe
    const x0 = Math.round(width * 0.08);
    let y = Math.round(height * 0.12);
    for (const [text, size] of [
      ['Hóa đơn bán lẻ', 64],
      ['Cửa hàng tạp hóa Minh Phát', 44],
      ['Địa chỉ: 12 Nguyễn Trãi, Hải Dương', 38],
      ['Số tiền: 1.250.000 VND', 40],
      ['Xin cảm ơn quý khách!', 38],
    ]) {
      ctx.font = `${size}px Roboto`;
      ctx.fillText(text, x0, y);
      y += Math.round(size * 1.9);
    }
    ctx.restore();
    // Denser speckle than the table fixture's variant.
    const rand = mulberry32(20261014);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const count = Math.round(width * height * 0.0004);
    for (let i = 0; i < count; i += 1) {
      ctx.fillRect(Math.round(rand() * width), Math.round(rand() * height), 2, 2);
    }
  }

  async function scanPageJpeg(draw) {
    const [w, h] = a4(200);
    const canvas = createCanvas(w, h);
    draw(canvas.getContext('2d'), w, h);
    return canvas.encode('jpeg', 0.9);
  }
  const mathScan = await makeScanPdf([await scanPageJpeg(drawMathPage)], 'ocr-scan-math');
  writeFileSync(join(here, 'ocr-scan-math.pdf'), mathScan);
  const noisyScan = await makeScanPdf([await scanPageJpeg(drawNoisyPage)], 'ocr-scan-noisy');
  writeFileSync(join(here, 'ocr-scan-noisy.pdf'), noisyScan);

  // A/B rasters: per-golden-page PNGs at each matrix cell's long-edge size
  // (the Rust runner cannot rasterize PDFs — production rasters come from
  // pdf.js in the webview). Gitignored artifacts under ocr-ab-rasters/;
  // regenerated by this script. The prompt transfers 1:1 to production; the
  // raster pipeline (napi-resize vs pdf.js) diverges slightly — noted in the
  // phase-2 transfer claim.
  const GOLDEN_PAGES = [
    ['vn-en-1', VN_EN_LINES[0], drawScanLines],
    ['vn-en-2', VN_EN_LINES[1], drawScanLines],
    ['math-1', null, drawMathPage],
    ['noisy-1', null, drawNoisyPage],
  ];
  for (const px of [1024, 1280]) {
    const dir = join(here, 'ocr-ab-rasters', String(px));
    mkdirSync(dir, { recursive: true });
    for (const [stem, lines, draw] of GOLDEN_PAGES) {
      const [w, h] = a4(200);
      const scale = px / Math.max(w, h);
      const canvas = createCanvas(Math.round(w * scale), Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      if (lines) draw(ctx, w, h, lines);
      else draw(ctx, w, h);
      writeFileSync(join(dir, `${stem}.png`), await canvas.encode('png'));
    }
  }

  console.log(JSON.stringify({
    'ocr-scan-vn-en.pdf': vnEn.length,
    'ocr-scan-12p.pdf': scan12.length,
    'ocr-scan-table.pdf': tableScan.length,
    'ocr-scan-math.pdf': mathScan.length,
    'ocr-scan-noisy.pdf': noisyScan.length,
  }));
} catch (e) {
  console.warn(
    `[gen.mjs] OCR scan fixtures SKIPPED (${e.message.split('\n')[0]}) — tests/ocr-integration.spec.ts will self-skip`,
  );
}

// ===================== REDACT corpus (v0.9.0 phase 1 spike) =====================
// Fixture matrix F1–F14 for the redact spike (plans/261025-1908-.../phase-01).
// Synthetic secrets only. Output: tests/fixtures/redact/*.pdf (gitignored) +
// manifest.json whose redact rects are CALIBRATED from pdf.js text-item
// geometry in visual (display) space — the same space a user drags boxes in.
// The spike's own forward map is an independent re-derivation, so a shared
// transform bug cannot pass both sides silently.
{
  const {
    PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFString, PDFHexString,
    degrees,
  } = await import('pdf-lib');
  const REDACT_DIR = join(here, 'redact');
  mkdirSync(REDACT_DIR, { recursive: true });

  const SECRET_VN = 'BÍ MẬT 7431';
  const SECRET_ASCII = 'SECRET-007-ALPHA';

  // --- geometry (mirrors engine visibleGeometry + the visual forward map;
  // the spike imports the REAL visualToPageSpace and self-tests the pair) ---
  function geomOf(page) {
    const box = page.getCropBox();
    const rotate = ((((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360);
    const swap = rotate === 90 || rotate === 270;
    return {
      rotate, bx: box.x, by: box.y, w: box.width, h: box.height,
      visW: swap ? box.height : box.width, visH: swap ? box.width : box.height,
    };
  }
  function userToVisual(x, y, g) {
    const lx = x - g.bx, ly = y - g.by;
    switch (g.rotate) {
      case 90: return { vx: ly, vy: g.visH - lx };
      case 180: return { vx: g.w - lx, vy: g.h - ly };
      case 270: return { vx: g.visW - ly, vy: lx };
      default: return { vx: lx, vy: ly };
    }
  }
  // Visual bbox of a pdf.js text item (user-space transform + width/height),
  // honoring the item's text direction (a,b) for rotated draws.
  function itemVisualRect(item, g) {
    const [a, b, , , e, f] = item.transform;
    const h = item.height || 10;
    const w = item.width || 0;
    const dirLen = Math.hypot(a, b) || 1;
    const ux = a / dirLen, uy = b / dirLen;
    const nx = -uy, ny = ux; // ascent direction (perp, +90° CCW)
    const pts = [
      [e, f],
      [e + ux * w, f + uy * w],
      [e + ux * w + nx * 0.85 * h, f + uy * w + ny * 0.85 * h],
      [e + nx * 0.85 * h, f + ny * 0.85 * h],
      [e - nx * 0.25 * h, f - ny * 0.25 * h],
      [e + ux * w - nx * 0.25 * h, f + uy * w - ny * 0.25 * h],
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      const v = userToVisual(x, y, g);
      minX = Math.min(minX, v.vx); minY = Math.min(minY, v.vy);
      maxX = Math.max(maxX, v.vx); maxY = Math.max(maxY, v.vy);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // --- pdf.js extraction (also used by the spike oracle) ---
  let pdfjsCache = null;
  async function pdfjs() {
    pdfjsCache ??= await import(pathToFileURL(join(ROOT_PDFJS, 'legacy/build/pdf.mjs')).href);
    return pdfjsCache;
  }
  const ROOT_PDFJS = join(here, '..', '..', 'node_modules', 'pdfjs-dist');
  async function extractItems(bytes) {
    const mod = await pdfjs();
    const task = mod.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      standardFontDataUrl: pathToFileURL(`${join(here, '..', '..', 'node_modules/pdfjs-dist/standard_fonts')}/`).href,
    });
    const doc = await task.promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tc.items.filter((i) => 'str' in i && i.str.length > 0));
    }
    await task.destroy();
    return pages;
  }

  // --- body pages (Roboto subset VN lines, generous 44pt clearance) ---
  async function bodyDoc(title, pages) {
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    doc.setCreator('pdftoolkit-gen');
    doc.registerFontkit(fontkit);
    const roboto = await doc.embedFont(readFileSync(ROBOTO_TTF), { subset: true });
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const made = [];
    for (let p = 1; p <= pages; p += 1) {
      const page = doc.addPage([595, 842]);
      page.drawText(`Hồ sơ kiểm thử ${title} — trang ${p}/${pages}`, { x: 48, y: 800, size: 12, font: roboto });
      for (let i = 0; i < 7; i += 1) {
        page.drawText(`Dòng ${i + 1}: nội dung phải giữ nguyên — ăâêôơư ạếềễự 0123456789.`, {
          x: 48, y: 756 - i * 44, size: 10, font: roboto,
        });
      }
      // Register Helvetica on every page (raw-op fixtures reference it; WinAnsi
      // is byte-transparent for hand-written ASCII operands).
      page.drawText('.', { x: 6, y: 6, size: 6, font: helv });
      made.push({ page, roboto, helv });
    }
    return { doc, made };
  }
  // First /Font resource name on a page (raw ops reference it).
  function firstFontName(doc, page) {
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    const fonts = res instanceof PDFDict ? doc.context.lookup(res.get(PDFName.of('Font'))) : null;
    if (!(fonts instanceof PDFDict)) throw new Error('no /Font resources (decoy drawText missing?)');
    for (const [k] of fonts.entries()) {
      const s = String(k);
      if (s.startsWith('/')) return s.slice(1);
    }
    throw new Error('empty /Font dict');
  }
  function rawStream(doc, dictObj, bytes) {
    const dict = doc.context.obj(dictObj);
    return doc.context.register(PDFRawStream.of(dict, bytes));
  }
  function replaceContents(doc, page, opsText) {
    const bytes = Buffer.from(opsText, 'latin1');
    const ref = rawStream(doc, { Length: bytes.length, Filter: PDFName.of('FlateDecode') }, deflateSync(bytes));
    page.node.set(PDFName.of('Contents'), ref);
  }
  const escLit = (s) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  const hexLit = (s) => `<${Buffer.from(s, 'latin1').toString('hex').toUpperCase()}>`;

  // --- rect calibration: find the secret on page `p1`, return visual rects (+pad).
  // Strategy 1: single items whose str contains the needle (F1/F3/F4/F11/F13).
  // Strategy 2 (TJ arrays split into per-element items): group items sharing a
  // visual baseline, sort by x, concatenate, match the needle, merge the boxes
  // of all items overlapping the char span (F2). Throws when nothing matches.
  // calibrateItem returns the raw ITEM (F1b needs the box to carve a sub-rect). ---
  async function calibrateItem(bytes, p1, needle) {
    const items = (await extractItems(bytes))[p1 - 1] ?? [];
    const hits = items.filter((i) => i.str.includes(needle));
    if (hits.length === 0) {
      throw new Error(`calibration miss: "${needle}" not extracted on page ${p1}`);
    }
    return hits[0];
  }
  async function calibrateRects(bytes, doc, p1, needle, pad = 3) {
    const page = doc.getPage(p1 - 1);
    const g = geomOf(page);
    const items = (await extractItems(bytes))[p1 - 1] ?? [];
    const boxOf = (i) => {
      const r = itemVisualRect(i, g);
      return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    };
    const exact = items.filter((i) => i.str.includes(needle));
    if (exact.length > 0) return exact.map(boxOf);
    const groups = new Map();
    for (const it of items) {
      const v = userToVisual(it.transform[4], it.transform[5], g);
      const key = Math.round(v.vy);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const rects = [];
    for (const [, grp] of groups) {
      grp.sort((a, b) => a.transform[4] - b.transform[4]);
      const joined = grp.map((i) => i.str).join('');
      const at = joined.indexOf(needle);
      if (at < 0) continue;
      let cursor = 0;
      const covered = [];
      for (const it of grp) {
        const s = cursor, e = cursor + it.str.length;
        cursor = e;
        if (e > at && s < at + needle.length) covered.push(it);
      }
      if (covered.length > 0) {
        const boxes = covered.map((i) => itemVisualRect(i, g));
        const x = Math.min(...boxes.map((b) => b.x)) - pad;
        const y = Math.min(...boxes.map((b) => b.y)) - pad;
        const w = Math.max(...boxes.map((b) => b.x + b.w)) - x + pad - pad;
        const h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
        rects.push({ x, y, w, h });
      }
    }
    if (rects.length === 0) {
      throw new Error(`calibration miss (grouped): "${needle}" not extracted on page ${p1}`);
    }
    return rects;
  }

  const manifest = { generated: new Date().toISOString(), secrets: { vn: SECRET_VN, ascii: SECRET_ASCII }, fixtures: [] };
  async function emit(file, meta, bytes) {
    writeFileSync(join(REDACT_DIR, file), bytes);
    manifest.fixtures.push({ file, ...meta });
  }

  // ---------- F1 simple single-Tj VN body text (eligible; GATING) ----------
  {
    const { doc, made } = await bodyDoc('redact-f1', 3);
    made[1].page.drawText(SECRET_VN, { x: 60, y: 400, size: 14, font: made[1].roboto });
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = await calibrateRects(bytes, doc, 2, SECRET_VN);
    await emit('F1-simple.pdf', {
      class: 'F1', partition: 'eligible', secret: SECRET_VN, pages: 3,
      redactPages: [2], rectsVisual: { 2: rects }, expectCensusPages: {}, expectSurvivePages: [],
      note: 'single-Tj Roboto line; whole-line rect → surgical',
    }, bytes);
  }
  // ---------- F1b partial-block probe (eligible; expected disposition = refuse page) ----------
  {
    const { doc, made } = await bodyDoc('redact-f1b', 1);
    const line = `Mã tham chiếu: ${SECRET_ASCII} hết hiệu lực`;
    made[0].page.drawText(line, { x: 60, y: 400, size: 12, font: made[0].roboto });
    const bytes = await doc.save({ useObjectStreams: false });
    // Sub-rect covering ONLY the secret word inside the single-Tj line:
    // proportional char offsets on the calibrated item box, kept strictly inside.
    const item = await calibrateItem(bytes, 1, SECRET_ASCII);
    const g = geomOf(doc.getPage(0));
    const r = itemVisualRect(item, g);
    const pre = line.indexOf(SECRET_ASCII);
    const fx = pre / line.length;
    const fw = SECRET_ASCII.length / line.length;
    const rect = { x: r.x + r.w * fx + 1, y: r.y, w: r.w * fw - 2, h: r.h };
    await emit('F1b-partial.pdf', {
      class: 'F1b', partition: 'eligible', secret: SECRET_ASCII, pages: 1,
      redactPages: [1], rectsVisual: { 1: [rect] }, expectCensusPages: {}, expectSurvivePages: [],
      note: 'rect touches ONE word of a multi-word single-Tj line → must refuse the page, never shred',
    }, bytes);
  }
  // ---------- F2 TJ-array shows, mixed literal/hex elements (eligible; MANDATORY) ----------
  {
    const { doc, made } = await bodyDoc('redact-f2', 3);
    const page = made[1].page;
    const f1 = made[1].helv.name;
    replaceContents(doc, page, [
      `BT /${f1} 12 Tf 48 756 Td (Body line replacement - keep) Tj ET`,
      `BT /${f1} 12 Tf 60 520 Td [(Noise line A) 3 (keep me)] TJ ET`,
      `BT /${f1} 12 Tf 60 480 Td [(SE) 20 (CR) 20 (ET-0) 20 (07-AL) 20 (PHA)] TJ ET`,
      `BT /${f1} 12 Tf 60 440 Td [<4E 6F 69 73 65 20 42> 5 (end)] TJ ET`,
      `BT /${f1} 12 Tf 60 400 Td (Noise line C) Tj ET`,
    ].join('\n'));
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = await calibrateRects(bytes, doc, 2, SECRET_ASCII);
    await emit('F2-tj-array.pdf', {
      class: 'F2', partition: 'eligible', secret: SECRET_ASCII, pages: 3,
      redactPages: [2], rectsVisual: { 2: rects }, expectCensusPages: {}, expectSurvivePages: [],
      note: 'secret assembled across TJ array elements (literal kerned pieces)',
    }, bytes);
  }
  // ---------- F3 hex-operand + octal-escaped literal shows (eligible) ----------
  {
    const { doc, made } = await bodyDoc('redact-f3', 2);
    const page = made[1].page;
    const f1 = made[1].helv.name;
    replaceContents(doc, page, [
      `BT /${f1} 12 Tf 48 756 Td (Body replacement keep) Tj ET`,
      `BT /${f1} 12 Tf 60 480 Td ${hexLit(SECRET_ASCII)} Tj ET`,
      `BT /${f1} 12 Tf 60 440 Td (\\123\\105CRET-007-ALPHA) Tj ET`,
    ].join('\n'));
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = await calibrateRects(bytes, doc, 2, SECRET_ASCII);
    if (rects.length !== 2) throw new Error(`F3 expected 2 secret items, got ${rects.length}`);
    await emit('F3-hex.pdf', {
      class: 'F3', partition: 'eligible', secret: SECRET_ASCII, pages: 2,
      redactPages: [2], rectsVisual: { 2: rects }, expectCensusPages: {}, expectSurvivePages: [],
      note: 'hex operand Tj + octal-escaped literal Tj',
    }, bytes);
  }
  // ---------- F4 Type 3 font text (expected-escalate) ----------
  {
    const { doc, made } = await bodyDoc('redact-f4', 2);
    const page = made[1].page;
    const f1 = made[1].helv.name;
    const ctx = doc.context;
    // One CharProc glyph (a filled rect) shared by every code via /Differences.
    const gx = rawStream(doc, { Length: 18 }, Buffer.from('0 0 600 700 re f', 'latin1'));
    const codes = [...SECRET_ASCII].map((_, i) => i + 1);
    const bf = codes.map((c, i) => `<${String(c).padStart(4, '0')}> <${Buffer.from(SECRET_ASCII[i], 'utf16le').swap16().toString('hex').padStart(4, '0')}>`).join('\n');
    const cmap = rawStream(doc, { Length: 0 }, Buffer.from([
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin', 'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
      '1 begincodespacerange', '<0000> <ffff>', 'endcodespacerange',
      `${codes.length} beginbfchar`, bf, 'endbfchar',
      'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
    ].join('\n'), 'latin1'));
    const diffArr = [PDFNumber.of(1), ...codes.map(() => PDFName.of('gx'))];
    const t3Dict = ctx.obj({
      Type: PDFName.of('Font'), Subtype: PDFName.of('Type3'),
      FontBBox: ctx.obj([0, 0, 1000, 1000].map((n) => PDFNumber.of(n))),
      FontMatrix: ctx.obj([0.001, 0, 0, 0.001, 0, 0].map((n) => PDFNumber.of(n))),
      CharProcs: ctx.obj({ gx }),
      Encoding: ctx.obj({ Type: PDFName.of('Encoding'), Differences: ctx.obj(diffArr) }),
      FirstChar: PDFNumber.of(1), LastChar: PDFNumber.of(codes.length),
      Widths: ctx.obj(codes.map(() => PDFNumber.of(600))),
      ToUnicode: cmap,
    });
    const t3Ref = ctx.register(t3Dict);
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    const fonts = doc.context.lookup(res.get(PDFName.of('Font')));
    fonts.set(PDFName.of('T3'), t3Ref);
    const codeHex = codes.map((c) => String(c).padStart(2, '0')).join('');
    replaceContents(doc, page, [
      `BT /${f1} 12 Tf 48 756 Td (Body replacement keep) Tj ET`,
      `BT /T3 24 Tf 60 480 Td <${codeHex}> Tj ET`,
    ].join('\n'));
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = await calibrateRects(bytes, doc, 2, SECRET_ASCII);
    await emit('F4-type3.pdf', {
      class: 'F4', partition: 'escalate', secret: SECRET_ASCII, pages: 2,
      redactPages: [2], rectsVisual: { 2: rects }, expectCensusPages: { 2: ['type3'] }, expectSurvivePages: [],
      note: 'Type3 font + ToUnicode; census must flag type3 → rasterize',
    }, bytes);
  }
  // ---------- F5 ActualText /Span + 3 Tr invisible text (expected-escalate; marker classes) ----------
  {
    const { doc, made } = await bodyDoc('redact-f5', 2);
    const page = made[1].page;
    const f1 = made[1].helv.name;
    replaceContents(doc, page, [
      `BT /${f1} 12 Tf 48 756 Td (Body replacement keep) Tj ET`,
      `/Span <</ActualText ${escLit(SECRET_ASCII)}>> BDC`,
      `BT /${f1} 12 Tf 60 480 Td (marked content glyphs) Tj ET`,
      'EMC',
      `BT /${f1} 12 Tf 3 Tr 60 440 Td ${escLit(SECRET_ASCII)} Tj ET`,
    ].join('\n'));
    const bytes = await doc.save({ useObjectStreams: false });
    await emit('F5-actualtext.pdf', {
      class: 'F5', partition: 'escalate', secret: SECRET_ASCII, pages: 2,
      redactPages: [2], rectsVisual: { 2: [] }, expectCensusPages: { 2: ['actualtext', 'tr3'] }, expectSurvivePages: [],
      note: 'ActualText BDC marker + invisible 3 Tr show; census must flag both → rasterize',
    }, bytes);
  }
  // ---------- F6 multi-font page, interleaved blocks (eligible; GATING) ----------
  {
    const { doc, made } = await bodyDoc('redact-f6', 2);
    const page = made[1].page;
    // The secret splits ACROSS two blocks/fonts: 'BÍ MẬT' (subset Roboto) and
    // ' 7431' (Helvetica WinAnsi). Decoy lines in BOTH fonts interleave and
    // must survive (damage check).
    page.drawText('Tiêu đề Roboto giữ lại', { x: 48, y: 520, size: 12, font: made[1].roboto });
    page.drawText('BÍ MẬT', { x: 60, y: 380, size: 14, font: made[1].roboto });
    page.drawText('7431 - ma duoi', { x: 130, y: 352, size: 12, font: made[1].helv });
    page.drawText('Helvetica decoy keep', { x: 48, y: 320, size: 12, font: made[1].helv });
    const bytes = await doc.save({ useObjectStreams: false });
    const g = geomOf(page);
    const part1 = await calibrateRects(bytes, doc, 2, 'BÍ MẬT');
    const part2 = await calibrateRects(bytes, doc, 2, '7431');
    await emit('F6-multifont.pdf', {
      class: 'F6', partition: 'eligible', secret: SECRET_VN, pages: 2,
      redactPages: [2], rectsVisual: { 2: [...part1, ...part2] }, expectCensusPages: {}, expectSurvivePages: [],
      note: 'secret split across 2 fonts/blocks (Roboto glyph-ids + Helvetica WinAnsi); interleaved decoys must survive',
    }, bytes);
  }
  // ---------- F7 PatternType 1 tiling pattern containing glyphs (expected-escalate) ----------
  {
    const { doc, made } = await bodyDoc('redact-f7', 2);
    const page = made[1].page;
    const f1 = made[1].helv.name;
    const patOps = `0.25 0.35 0.5 rg BT /${f1} 12 Tf 20 40 Td ${escLit(SECRET_ASCII)} Tj ET`;
    const patRef = rawStream(doc, {
      Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(1), PaintType: PDFNumber.of(1),
      TilingType: PDFNumber.of(1), BBox: doc.context.obj([0, 0, 200, 200].map((n) => PDFNumber.of(n))),
      XStep: PDFNumber.of(200), YStep: PDFNumber.of(200), Length: patOps.length,
      Resources: doc.context.obj({ Font: doc.context.obj({ [f1]: made[1].helv.ref }) }),
    }, Buffer.from(patOps, 'latin1'));
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    res.set(PDFName.of('Pattern'), doc.context.obj({ P0: patRef }));
    replaceContents(doc, page, [
      `BT /${f1} 12 Tf 48 756 Td (Body replacement keep) Tj ET`,
      'q /Pattern cs /P0 scn 30 300 520 260 re f Q',
    ].join('\n'));
    const bytes = await doc.save({ useObjectStreams: false });
    await emit('F7-pattern.pdf', {
      class: 'F7', partition: 'escalate', secret: SECRET_ASCII, pages: 2,
      redactPages: [2], rectsVisual: { 2: [{ x: 30, y: 300, w: 520, h: 260 }] },
      expectCensusPages: { 2: ['pattern-text'] }, expectSurvivePages: [],
      note: 'text inside a tiling pattern (pdf.js extraction misses it — census raw-scan must catch) → rasterize',
    }, bytes);
  }
  // ---------- F8 text-bearing annotation (expected-escalate; outside page /Contents) ----------
  {
    const { doc, made } = await bodyDoc('redact-f8', 2);
    const page = made[0].page;
    const annotRef = doc.context.register(doc.context.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('FreeText'),
      Rect: doc.context.obj([60, 380, 320, 410].map((n) => PDFNumber.of(n))),
      Contents: PDFString.of(SECRET_ASCII), F: PDFNumber.of(4), DA: PDFString.of('/Helv 10 Tf'),
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
    const bytes = await doc.save({ useObjectStreams: false });
    await emit('F8-annot.pdf', {
      class: 'F8', partition: 'escalate', secret: SECRET_ASCII, pages: 2,
      redactPages: [1], rectsVisual: { 1: [{ x: 57, y: 377, w: 266, h: 36 }] },
      expectCensusPages: { 1: ['annot-text'] }, expectSurvivePages: [],
      note: 'FreeText /Contents carries the secret (not page content) → census flag; dispose = drop annot + raster',
    }, bytes);
  }
  // ---------- F9 rotated/cropped pages, rects in visual space (eligible; GATING) ----------
  {
    const { doc, made } = await bodyDoc('redact-f9', 4);
    const cfgs = [
      { rot: 90, drawRot: 90 }, { rot: 180, drawRot: 0 }, { rot: 270, drawRot: 270 }, { rot: 0, drawRot: 0, crop: true },
    ];
    for (const [i, cfg] of cfgs.entries()) {
      const { page } = made[i];
      if (cfg.rot !== 0) page.setRotation(degrees(cfg.rot));
      if (cfg.crop) page.setCropBox(40, 60, 515, 722);
      page.drawText(SECRET_VN, { x: 400, y: 420, size: 14, font: made[i].roboto, rotate: degrees(cfg.drawRot) });
    }
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = {};
    for (const p of [1, 2, 3, 4]) rects[p] = await calibrateRects(bytes, doc, p, SECRET_VN);
    await emit('F9-rotated.pdf', {
      class: 'F9', partition: 'eligible', secret: SECRET_VN, pages: 4,
      redactPages: [1, 2, 3, 4], rectsVisual: rects, expectCensusPages: {}, expectSurvivePages: [],
      note: 'r90/r180/r270 + cropped r0; rects calibrated in VISUAL space; draw-angle compensated on 90/270',
    }, bytes);
  }
  // ---------- F10 verify-scoping: secret on a redacted page AND an unredacted page ----------
  {
    const { doc, made } = await bodyDoc('redact-f10', 3);
    made[0].page.drawText(SECRET_VN, { x: 60, y: 400, size: 14, font: made[0].roboto });
    made[2].page.drawText(SECRET_VN, { x: 60, y: 400, size: 14, font: made[2].roboto });
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = { 1: await calibrateRects(bytes, doc, 1, SECRET_VN) };
    await emit('F10-scoped.pdf', {
      class: 'F10', partition: 'scoping', secret: SECRET_VN, pages: 3,
      redactPages: [1], rectsVisual: rects, expectCensusPages: {}, expectSurvivePages: [3],
      note: 'page 1 redacted; page 3 copy must SURVIVE (scope proof — unredacted duplicate must not fail, must not be scrubbed)',
    }, bytes);
  }
  // ---------- F11 text inside a Form XObject with non-identity /Matrix (expected-escalate) ----------
  {
    const { doc, made } = await bodyDoc('redact-f11', 2);
    const page = made[1].page;
    const f1 = made[1].helv.name;
    const formOps = `BT /${f1} 14 Tf 30 40 Td ${escLit(SECRET_ASCII)} Tj ET`;
    const formRef = rawStream(doc, {
      Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'),
      BBox: doc.context.obj([0, 0, 400, 100].map((n) => PDFNumber.of(n))),
      Matrix: doc.context.obj([1.5, 0, 0, 1.5, 200, 150].map((n) => PDFNumber.of(n))),
      Length: formOps.length,
      Resources: doc.context.obj({ Font: doc.context.obj({ [f1]: made[1].helv.ref }) }),
    }, Buffer.from(formOps, 'latin1'));
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    res.set(PDFName.of('XObject'), doc.context.obj({ X0: formRef }));
    replaceContents(doc, page, [
      `BT /${f1} 12 Tf 48 756 Td (Body replacement keep) Tj ET`,
      'q /X0 Do Q',
    ].join('\n'));
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = await calibrateRects(bytes, doc, 2, SECRET_ASCII);
    await emit('F11-xobject.pdf', {
      class: 'F11', partition: 'escalate', secret: SECRET_ASCII, pages: 2,
      redactPages: [2], rectsVisual: { 2: rects }, expectCensusPages: { 2: ['xobject-text'] }, expectSurvivePages: [],
      note: 'text inside Form XObject (non-identity /Matrix); pdf.js discovery recurses, WM walker does not → census flag → rasterize',
    }, bytes);
  }
  // ---------- F12 doc-level channels (finding 2) ----------
  {
    const { doc } = await bodyDoc('redact-f12', 1);
    const ctx = doc.context;
    doc.setAuthor(`Người giữ: ${SECRET_ASCII}`);
    doc.setSubject(`Chủ đề ${SECRET_VN}`);
    // XMP metadata stream
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${SECRET_ASCII}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const xmpRef = rawStream(doc, { Length: Buffer.byteLength(xmp), Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML') }, Buffer.from(xmp, 'utf8'));
    doc.catalog.set(PDFName.of('Metadata'), xmpRef);
    // /Outlines with a secret title
    const outlineItem = ctx.obj({
      Title: PDFHexString.fromText(`Mục lục ${SECRET_VN}`), Prev: null, Next: null,
    });
    const outlinesRef = ctx.register(ctx.obj({
      Type: PDFName.of('Outlines'), First: ctx.register(outlineItem), Last: ctx.register(outlineItem), Count: PDFNumber.of(1),
    }));
    outlineItem.set(PDFName.of('Parent'), outlinesRef);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
    // /Names: /JavaScript name + /EmbeddedFile
    const jsAction = ctx.register(ctx.obj({
      S: PDFName.of('JavaScript'), JS: PDFString.of(`app.alert("${SECRET_ASCII}")`),
    }));
    const efStream = rawStream(doc, { Length: SECRET_ASCII.length, Type: PDFName.of('EmbeddedFile') }, Buffer.from(SECRET_ASCII, 'latin1'));
    const filespec = ctx.register(ctx.obj({
      Type: PDFName.of('Filespec'), F: PDFString.of('secret.txt'), UF: PDFHexString.fromText('secret.txt'),
      EF: ctx.obj({ F: efStream, UF: efStream }),
    }));
    doc.catalog.set(PDFName.of('Names'), ctx.obj({
      JavaScript: ctx.obj({ Names: ctx.obj([PDFString.of(`két-xuất-${SECRET_ASCII}`), jsAction]) }),
      EmbeddedFiles: ctx.obj({ Names: ctx.obj([PDFString.of(`tệp-${SECRET_ASCII}.txt`), filespec]) }),
    }));
    // AcroForm field /V
    const fieldRef = ctx.register(ctx.obj({
      FT: PDFName.of('Tx'), T: PDFString.of('SecretField'), V: PDFHexString.fromText(SECRET_ASCII),
      Rect: ctx.obj([100, 100, 260, 120].map((n) => PDFNumber.of(n))),
    }));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([fieldRef]) }));
    const bytes = await doc.save({ useObjectStreams: false });
    await emit('F12-doc-channels.pdf', {
      class: 'F12', partition: 'doc-channels', secret: SECRET_ASCII, secretsAll: [SECRET_VN, SECRET_ASCII], pages: 1,
      redactPages: [], rectsVisual: {}, expectCensusPages: {}, expectSurvivePages: [],
      docChannels: ['doc-info:Author', 'doc-info:Subject', 'doc-xmp', 'doc-outlines', 'doc-javascript', 'doc-embeddedfile', 'doc-acroform:V'],
      note: 'secret in 7 doc channels; scrub must clean all; body content untouched',
    }, bytes);
  }
  // ---------- F13 A0 poster oversized page (edge; raster clamp proof) ----------
  {
    const { doc, made } = await bodyDoc('redact-f13', 1);
    const page = made[0].page;
    page.node.set(PDFName.of('MediaBox'), doc.context.obj([0, 0, 2384, 3370].map((n) => PDFNumber.of(n))));
    page.drawText(`Bản vẽ khổ A0 — ${SECRET_VN}`, { x: 200, y: 2800, size: 36, font: made[0].roboto });
    for (let i = 0; i < 30; i += 1) {
      page.drawText(`Chi tiết kỹ thuật dòng ${i + 1}: kích thước kiểm soát 0912-33xx-mm.`, { x: 200, y: 2600 - i * 60, size: 20, font: made[0].roboto });
    }
    const bytes = await doc.save({ useObjectStreams: false });
    const rects = await calibrateRects(bytes, doc, 1, SECRET_VN);
    await emit('F13-poster.pdf', {
      class: 'F13', partition: 'edge', secret: SECRET_VN, pages: 1,
      redactPages: [1], rectsVisual: { 1: rects }, expectCensusPages: {}, expectSurvivePages: [],
      note: 'A0 poster 2384x3370 — raster clamp formula + pre-encode rect painting proof',
    }, bytes);
  }
  // ---------- F14 widget/hidden/AP-annot inventory (edge; finding 7) ----------
  {
    const { doc, made } = await bodyDoc('redact-f14', 1);
    const page = made[0].page;
    const ctx = doc.context;
    // Multi-widget field: shared /T, two sibling widgets.
    const fieldDict = ctx.obj({
      FT: PDFName.of('Tx'), T: PDFString.of('JointField'), V: PDFHexString.fromText(SECRET_ASCII),
    });
    const fieldRef = ctx.register(fieldDict);
    const w1 = ctx.register(ctx.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('Widget'), Parent: fieldRef,
      Rect: ctx.obj([60, 380, 260, 404].map((n) => PDFNumber.of(n))),
    }));
    const w2 = ctx.register(ctx.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('Widget'), Parent: fieldRef,
      Rect: ctx.obj([60, 330, 260, 354].map((n) => PDFNumber.of(n))),
    }));
    fieldDict.set(PDFName.of('Kids'), ctx.obj([w1, w2]));
    // FreeText whose /AP stream draws the secret across a BBox wider than /Rect.
    const f1 = made[0].helv.name;
    const apOps = `BT /${f1} 10 Tf 5 30 Td ${escLit(SECRET_ASCII)} Tj ET`;
    const apRef = rawStream(doc, {
      Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'),
      BBox: doc.context.obj([0, 0, 400, 100].map((n) => PDFNumber.of(n))), Length: apOps.length,
      Resources: doc.context.obj({ Font: doc.context.obj({ [f1]: made[0].helv.ref }) }),
    }, Buffer.from(apOps, 'latin1'));
    const freeText = ctx.register(ctx.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('FreeText'),
      Rect: ctx.obj([300, 500, 420, 520].map((n) => PDFNumber.of(n))),
      Contents: PDFString.of(SECRET_ASCII), F: PDFNumber.of(4),
      AP: ctx.obj({ N: apRef }), DA: PDFString.of('/F1 10 Tf'),
    }));
    // Hidden annotation (/F bit 2).
    const hidden = ctx.register(ctx.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('Square'),
      Rect: ctx.obj([100, 150, 200, 180].map((n) => PDFNumber.of(n))),
      Contents: PDFString.of(SECRET_ASCII), F: PDFNumber.of(2),
    }));
    page.node.set(PDFName.of('Annots'), ctx.obj([w1, w2, freeText, hidden]));
    const bytes = await doc.save({ useObjectStreams: false });
    await emit('F14-annots.pdf', {
      class: 'F14', partition: 'edge', secret: SECRET_ASCII, pages: 1,
      redactPages: [1], rectsVisual: { 1: [{ x: 57, y: 497, w: 366, h: 26 }] },
      expectCensusPages: { 1: ['widget', 'annot-text', 'annot-ap-text', 'annot-hidden'] }, expectSurvivePages: [],
      note: 'multi-widget field (shared /T) + FreeText AP text + hidden /F 2 annot → census flags all; dispose = drop annots, clear /V, raster',
    }, bytes);
  }

  writeFileSync(join(REDACT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    redactCorpus: manifest.fixtures.length,
    dir: 'tests/fixtures/redact/',
  }));

  }
