import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

// Solid indigo square with white "P" block: simple flat icon, no external assets.
function makePng(size, bg, fg, maskable) {
  const pad = maskable ? Math.floor(size * 0.12) : 0;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const pr = (bg >> 16) & 255, pg = (bg >> 8) & 255, pb = bg & 255;
  const fr = (fg >> 16) & 255, fgG = (fg >> 8) & 255, fb = fg & 255;
  const barW = Math.floor(size * 0.16);
  const barH = Math.floor(size * 0.52);
  const barX = Math.floor((size - barW) / 2);
  const barY = Math.floor((size - barH) / 2);
  const holeW = Math.floor(size * 0.2);
  const holeH = Math.floor(size * 0.14);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    const inPad = y < pad || y >= size - pad;
    for (let x = 0; x < size; x++) {
      let r = pr, g = pg, b = pb;
      const inBarX = x >= barX && x < barX + barW;
      const inBarY = y >= barY && y < barY + barH;
      const inHole = x >= barX && x < barX + holeW && y >= barY && y < barY + holeH;
      if (!inPad && inBarX && inBarY && !inHole) { r = fr; g = fgG; b = fb; }
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

const dir = join(process.cwd(), 'public', 'icons');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'icon-192.png'), makePng(192, 0x4f46e5, 0xffffff, false));
writeFileSync(join(dir, 'icon-512.png'), makePng(512, 0x4f46e5, 0xffffff, false));
writeFileSync(join(dir, 'icon-maskable-512.png'), makePng(512, 0x4f46e5, 0xffffff, true));
console.log('icons written');
