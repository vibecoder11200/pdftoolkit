// A/B benchmark (plan v0.4.0 phase 7, gate D9): skia JPEG encoder
// (@napi-rs/canvas — same libjpeg-turbo family as the browser's
// canvas.toBlob baseline) vs mozjpeg wasm (@jsquash/jpeg, what the
// worker's encodeJpeg would use).
//
// Fixtures (phase-07): a scan-like A4 300dpi page (text + flat areas) and
// a photo-like image (gradient + noise). Three nominal quality levels —
// the app's actual preset points (compress balanced .75 / small .60,
// pdf-to-img .92). canvas.toBlob quality is 0-1 and maps to libjpeg
// quality 1-100 (Chrome multiplies by 100); @napi-rs/canvas takes 0-100
// directly (verified empirically: 0.75 ≡ 1 ≈ floor, 10 < 50 < 75 < 100
// monotone), so matched numbers = comparable nominal quality.
//
// GO rule (plan D9): >= 10% average size reduction at comparable quality.
// 5-10% weak; < 5% NO-GO.
//
// Run: node scripts/ab-mozjpeg.mjs   (pure stdout — writes no files)

import { createCanvas } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The emscripten glue's instantiateAsync prefers global fetch when it exists
// (Node 18+) and file:// fetch is not implemented in undici — so under plain
// Node we hand it a compiled WebAssembly.Module instead of letting it load
// mozjpeg_enc.wasm itself. init() lives on the encode.js subpath (index.js
// does not re-export it).
async function initMozjpegEncode() {
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve('@jsquash/jpeg/package.json'));
  const wasmBinary = readFileSync(join(pkgDir, 'codec', 'enc', 'mozjpeg_enc.wasm'));
  const { init, default: encode } = await import('@jsquash/jpeg/encode.js');
  await init(await WebAssembly.compile(wasmBinary));
  return encode;
}

// Deterministic PRNG so the numbers are reproducible session to session.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scan-like A4 @ 300dpi: 2480x3508. Text paragraphs + flat bands/table. */
function renderScanFixture() {
  const W = 2480;
  const H = 3508;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // flat header band + footer band (flat areas are where mozjpeg's
  // trellis/optimize-coding shine)
  ctx.fillStyle = '#e8edf3';
  ctx.fillRect(0, 0, W, 260);
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 96px sans-serif';
  ctx.fillText('BÁO CÁO TÀI CHÍNH QUÝ IV', 120, 160);
  // text body: dark-on-white paragraph lines
  ctx.font = '42px sans-serif';
  ctx.fillStyle = '#111827';
  const line = 'Doanh thu thuần về bán hàng và cung cấp dịch vụ tăng 12,4% so với cùng kỳ năm trước.';
  for (let y = 420; y < H - 400; y += 84) {
    const indent = (Math.floor(y / 84) % 4) * 40;
    ctx.fillText(line.slice(0, 40 + (Math.floor(y / 84) % 30)), 120 + indent, y);
  }
  // flat table grid
  const rowH = 110;
  for (let r = 0; r < 6; r += 1) {
    const y = H - 1000 + r * rowH;
    ctx.fillStyle = r % 2 === 0 ? '#f3f4f6' : '#ffffff';
    ctx.fillRect(120, y, W - 240, rowH);
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 2;
    ctx.strokeRect(120, y, W - 240, rowH);
  }
  return { canvas, width: W, height: H };
}

/** Photo-like: smooth gradients + seeded noise + soft blobs (high entropy). */
function renderPhotoFixture() {
  const W = 1600;
  const H = 1200;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const rnd = mulberry32(0x5eed);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      // smooth diagonal gradients per channel + two sinusoidal blobs
      const blob =
        Math.sin((x / W) * Math.PI * 2) * Math.cos((y / H) * Math.PI * 2);
      const noise = (rnd() - 0.5) * 56; // ±28 — camera-sensor-like grain
      d[i] = Math.max(0, Math.min(255, (x / W) * 255 * 0.8 + blob * 60 + noise));
      d[i + 1] = Math.max(0, Math.min(255, (y / H) * 255 * 0.7 + 40 + noise));
      d[i + 2] = Math.max(
        0,
        Math.min(255, ((x + y) / (W + H)) * 255 * 0.6 - blob * 40 + noise),
      );
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, width: W, height: H };
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

async function main() {
  const encode = await initMozjpegEncode();
  const qualities = [60, 75, 92]; // app preset points (0-100 scale, both sides)

  const fixtures = [
    ['scan-a4-300dpi', renderScanFixture()],
    ['photo-gradient-noise', renderPhotoFixture()],
  ];

  console.log(
    'fixture'.padEnd(22),
    'q'.padStart(3),
    'skia bytes'.padStart(13),
    'moz(p) bytes'.padStart(13),
    'delta(p)%'.padStart(10),
    'moz(b) bytes'.padStart(13),
    'delta(b)%'.padStart(10),
    'skia ms'.padStart(8),
    'moz ms'.padStart(8),
  );
  console.log('-'.repeat(108));

  const deltasProgressive = [];
  const deltasBaseline = [];

  for (const [name, { canvas }] of fixtures) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // jsquash reads {data,width,height} (module.encode(data.data, w, h, opts))
    const input = { data: imageData.data, width: imageData.width, height: imageData.height };
    for (const q of qualities) {
      const t0 = performance.now();
      const skia = canvas.toBuffer('image/jpeg', q); // 0-100 (verified scale)
      const skiaMs = performance.now() - t0;

      const t1 = performance.now();
      const progressive = new Uint8Array(await encode(input, { quality: q, progressive: true }));
      const t2 = performance.now();
      const baseline = new Uint8Array(await encode(input, { quality: q, progressive: false }));
      const mozMs = (t2 - t1) + (performance.now() - t2);

      const dP = ((skia.length - progressive.length) / skia.length) * 100;
      const dB = ((skia.length - baseline.length) / skia.length) * 100;
      deltasProgressive.push(dP);
      deltasBaseline.push(dB);
      console.log(
        name.padEnd(22),
        String(q).padStart(3),
        fmt(skia.length).padStart(13),
        fmt(progressive.length).padStart(13),
        dP.toFixed(1).padStart(10),
        fmt(baseline.length).padStart(13),
        dB.toFixed(1).padStart(10),
        skiaMs.toFixed(0).padStart(8),
        mozMs.toFixed(0).padStart(8),
      );
      // sanity: both outputs must be real JPEGs (SOI)
      if (progressive[0] !== 0xff || progressive[1] !== 0xd8) {
        throw new Error(`mozjpeg output is not a JPEG (q=${q}, ${name})`);
      }
      if (skia[0] !== 0xff || skia[1] !== 0xd8) {
        throw new Error(`skia output is not a JPEG (q=${q}, ${name})`);
      }
    }
  }

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const avgP = avg(deltasProgressive);
  const avgB = avg(deltasBaseline);
  console.log('-'.repeat(108));
  console.log(
    `avg delta progressive: ${avgP.toFixed(1)}%   avg delta baseline: ${avgB.toFixed(1)}%`,
  );
  const best = Math.max(avgP, avgB);
  const verdict = best >= 10 ? 'GO' : best >= 5 ? 'WEAK (5-10%)' : 'NO-GO';
  console.log(`D9 rule (>=10% avg at comparable quality): ${verdict}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
