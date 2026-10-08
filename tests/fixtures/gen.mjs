import { PDFDocument, PDFName, PDFHexString, PDFString, StandardFonts } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111111';
    let y = Math.round(height * 0.14);
    for (const [text, size] of lines) {
      ctx.font = `${size}px Roboto`;
      ctx.fillText(text, Math.round(width * 0.07), y);
      y += Math.round(size * 1.9);
    }
    return canvas.encode('jpeg', 0.9);
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
  // tests/ocr-integration.spec.ts.
  const vnEn = await makeScanPdf(
    [
      await renderScanPage(...a4(200), [
        ['Quarterly report', 64],
        ['total 42,518 items processed', 44],
        ['Regional warehouse, Building 7', 38],
        ['Revenue up 12.4 percent year over year', 38],
      ]),
      await renderScanPage(...a4(200), [
        ['Đặng Thị Thu Lĩnh', 64],
        ['kế hoạch 2026, Hà Nội', 44],
        ['Người phối ngẫu số 7', 38],
        ['Điện thoại: 0912 345 678', 38],
      ]),
    ],
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

  console.log(JSON.stringify({
    'ocr-scan-vn-en.pdf': vnEn.length,
    'ocr-scan-12p.pdf': scan12.length,
    'ocr-scan-table.pdf': tableScan.length,
  }));
} catch (e) {
  console.warn(
    `[gen.mjs] OCR scan fixtures SKIPPED (${e.message.split('\n')[0]}) — tests/ocr-integration.spec.ts will self-skip`,
  );
}
