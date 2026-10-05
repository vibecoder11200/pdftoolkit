import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Brand mark: rounded indigo tile + white folded page with a "P" knocked out.
// Geometry is the 32-unit grid of src/assets/logo.svg divided by 32 (unit
// square); public/favicon.svg and src/components/ui/logo.tsx mirror it.
const INDIGO = 0x4f46e5;
const INDIGO_DARK = 0x312e81; // favicon tile on dark OS scheme
const WHITE = 0xffffff;
const FOLD = 0xc7d2fe;
const FOLD_DARK = 0xa5b4fc;

const CORNER = 0.2;
const PAGE = { x0: 0.27, y0: 0.21, x1: 0.73, y1: 0.79 };
const FOLD_CUT = 0.13; // diagonal from (PAGE.x1 - FOLD_CUT, PAGE.y0) to (PAGE.x1, PAGE.y0 + FOLD_CUT)
const P_STEM = { x0: 0.345, x1: 0.435, y0: 0.28, y1: 0.7 };
const P_BOWL = { cx: 0.435, cy: 0.395, rOuter: 0.115, rInner: 0.045 };

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function inPage(u, v) {
  if (u < PAGE.x0 || u > PAGE.x1 || v < PAGE.y0 || v > PAGE.y1) return false;
  // Folded corner: above the cut diagonal is outside the page.
  if (u >= PAGE.x1 - FOLD_CUT && v < PAGE.y0 + (u - (PAGE.x1 - FOLD_CUT))) return false;
  return true;
}

function inFold(u, v) {
  const cutX = PAGE.x1 - FOLD_CUT;
  return u >= cutX && u <= PAGE.x1 && v >= PAGE.y0 && v <= PAGE.y0 + FOLD_CUT && v >= PAGE.y0 + (u - cutX);
}

function inGlyph(u, v) {
  if (u >= P_STEM.x0 && u <= P_STEM.x1 && v >= P_STEM.y0 && v <= P_STEM.y1) return true;
  const dx = u - P_BOWL.cx;
  const dy = v - P_BOWL.cy;
  const d2 = dx * dx + dy * dy;
  return u >= P_BOWL.cx && d2 <= P_BOWL.rOuter ** 2 && d2 >= P_BOWL.rInner ** 2;
}

// maskable: full-bleed square (launcher applies its own mask; the glyph already
// sits inside the 80% safe zone). touch (apple-touch-icon): full bleed too —
// iOS composites transparency to black. Otherwise: rounded corners, transparent
// outside (for icons declared purpose:'any').
function makeIconPng(size, { tile = INDIGO, fullBleed = false } = {}) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      let r = 0, g = 0, b = 0, a = 255;
      if (!fullBleed) {
        const qx = Math.max(CORNER - u, u - (1 - CORNER), 0);
        const qy = Math.max(CORNER - v, v - (1 - CORNER), 0);
        if (qx * qx + qy * qy > CORNER * CORNER) a = 0;
      }
      if (a !== 0) {
        let color = tile;
        if (inPage(u, v)) {
          color = inFold(u, v) ? FOLD : WHITE;
        }
        if (inGlyph(u, v)) color = tile;
        r = (color >> 16) & 255;
        g = (color >> 8) & 255;
        b = color & 255;
      }
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Same geometry as SVG paths on the 32-unit grid; the tile swaps to a darker
// indigo when the OS prefers dark so the tab icon keeps its contrast.
function faviconSvg() {
  const s = (n) => String(Math.round(n * 100) / 100);
  const page = `M${s(PAGE.x0 * 32)} ${s(PAGE.y0 * 32)}H${s((PAGE.x1 - FOLD_CUT) * 32)}L${s(PAGE.x1 * 32)} ${s((PAGE.y0 + FOLD_CUT) * 32)}V${s(PAGE.y1 * 32)}H${s(PAGE.x0 * 32)}Z`;
  const fold = `M${s((PAGE.x1 - FOLD_CUT) * 32)} ${s(PAGE.y0 * 32)}L${s(PAGE.x1 * 32)} ${s((PAGE.y0 + FOLD_CUT) * 32)}H${s((PAGE.x1 - FOLD_CUT) * 32)}Z`;
  const bowlTop = s((P_BOWL.cy - P_BOWL.rOuter) * 32);
  const bowlBottom = s((P_BOWL.cy + P_BOWL.rOuter) * 32);
  const stemBottom = s(P_STEM.y1 * 32);
  const holeTop = s((P_BOWL.cy - P_BOWL.rInner) * 32);
  const holeBottom = s((P_BOWL.cy + P_BOWL.rInner) * 32);
  const stemX = s(P_STEM.x0 * 32);
  const bowlX = s(P_BOWL.cx * 32);
  const rOuter = s(P_BOWL.rOuter * 32);
  const rInner = s(P_BOWL.rInner * 32);
  const glyph = `M${stemX} ${bowlTop}H${bowlX}A${rOuter} ${rOuter} 0 0 1 ${bowlX} ${bowlBottom}V${stemBottom}H${stemX}ZM${bowlX} ${holeTop}A${rInner} ${rInner} 0 0 1 ${bowlX} ${holeBottom}Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    .tile { fill: #4f46e5; }
    .fold { fill: #c7d2fe; }
    @media (prefers-color-scheme: dark) {
      .tile { fill: #312e81; }
      .fold { fill: #a5b4fc; }
    }
  </style>
  <rect class="tile" width="32" height="32" rx="${s(CORNER * 32)}" />
  <path d="${page}" fill="#ffffff" />
  <path class="fold" d="${fold}" />
  <path class="tile" d="${glyph}" fill-rule="evenodd" />
</svg>
`;
}

const publicDir = join(process.cwd(), 'public');
const iconsDir = join(publicDir, 'icons');
mkdirSync(iconsDir, { recursive: true });
writeFileSync(join(iconsDir, 'icon-192.png'), makeIconPng(192));
writeFileSync(join(iconsDir, 'icon-512.png'), makeIconPng(512));
writeFileSync(join(iconsDir, 'icon-maskable-512.png'), makeIconPng(512, { fullBleed: true }));
writeFileSync(join(publicDir, 'favicon-32.png'), makeIconPng(32));
writeFileSync(join(publicDir, 'apple-touch-icon-180.png'), makeIconPng(180, { fullBleed: true }));
writeFileSync(join(publicDir, 'favicon.svg'), faviconSvg());
console.log('icons written: icon-192/512, icon-maskable-512, favicon-32, apple-touch-icon-180, favicon.svg');
