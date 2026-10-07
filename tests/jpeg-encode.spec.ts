// Phase 7 (mozjpeg): real-encoder tests for the worker's encodeJpeg path.
// pdf.worker.ts itself cannot be imported under vitest (comlink expose()
// needs a worker global), so these exercise @jsquash/jpeg exactly the way
// the worker method calls it: duck-typed {data, width, height} input,
// {quality, progressive} options, Uint8Array output.
//
// The emscripten glue prefers global fetch for the wasm load and file://
// fetch is not implemented in Node's undici — so the wasm module is
// compiled explicitly and handed to init() (same dance as
// scripts/ab-mozjpeg.mjs). In the browser the glue resolves the wasm from
// its own chunk URL; this Node workaround does not affect that path.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EncodeOptions } from '@jsquash/jpeg/meta.js';

type Encode = (
  data: { data: Uint8ClampedArray; width: number; height: number },
  options?: Partial<EncodeOptions>,
) => Promise<ArrayBuffer>;

let encode: Encode;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve('@jsquash/jpeg/package.json'));
  const wasmBinary = readFileSync(join(pkgDir, 'codec', 'enc', 'mozjpeg_enc.wasm'));
  const mod = await import('@jsquash/jpeg/encode.js');
  await mod.init(await WebAssembly.compile(wasmBinary));
  encode = mod.default as unknown as Encode;
});

/** Small noisy gradient — enough entropy for size-based quality assertions. */
function noisyPixels(width: number, height: number): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 0x5eed;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const noise = (rnd() - 0.5) * 80;
      data[i] = (x / width) * 255 * 0.8 + noise;
      data[i + 1] = (y / height) * 255 * 0.7 + noise;
      data[i + 2] = ((x + y) / (width + height)) * 255 * 0.6 + noise;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** First SOF marker (0xc0 baseline / 0xc2 progressive), or null if absent. */
function sofMarker(bytes: Uint8Array): number | null {
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd9) ||
      marker === 0xff
    ) {
      i += 2; // standalone / RST markers carry no length
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return marker;
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

describe('mozjpeg encode (worker encodeJpeg codec)', () => {
  it('produces a JPEG: SOI magic bytes FF D8 and EOI trailer FF D9', async () => {
    const out = new Uint8Array(await encode(noisyPixels(64, 64), { quality: 75 }));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9);
  });

  it('size is monotonically non-increasing as quality drops', async () => {
    const pixels = noisyPixels(64, 64);
    const sizes = await Promise.all(
      [90, 60, 30].map(
        async (q) => new Uint8Array(await encode(pixels, { quality: q })).byteLength,
      ),
    );
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(sizes[1]).toBeGreaterThan(sizes[2]);
  });

  it('accepts progressive (SOF2) and baseline (SOF0) options', async () => {
    const pixels = noisyPixels(64, 64);
    const progressive = new Uint8Array(await encode(pixels, { quality: 75, progressive: true }));
    const baseline = new Uint8Array(await encode(pixels, { quality: 75, progressive: false }));
    expect(sofMarker(progressive)).toBe(0xc2);
    expect(sofMarker(baseline)).toBe(0xc0);
    // both decodable-shaped JPEGs with the EOI trailer
    for (const out of [progressive, baseline]) {
      expect(out[out.length - 2]).toBe(0xff);
      expect(out[out.length - 1]).toBe(0xd9);
    }
  });
});
