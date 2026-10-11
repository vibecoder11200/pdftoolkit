#!/usr/bin/env node
/*
 * sync-native-engine.mjs (v0.6.0 phase 1, R1.3) — pins the native OCR engine
 * (llama.cpp prebuilt llama-server) + the GLM-OCR GGUF pair for the desktop
 * sidecar. Writes scripts/native-engine-manifest.json (committed); `--check`
 * recomputes from the APIs WITHOUT writing and exits non-zero on drift —
 * the CI gate in pages.yml (PR) and desktop-release.yml (publish).
 *
 * Pin sources, zero engine downloads in CI:
 *   - GitHub release API: every asset carries a `digest` field ("sha256:…")
 *     — verified live at b11553 (all pinned assets, incl. the CUDA pair).
 *   - HF API at the pinned revision: GGUF sha256 resolves from the LFS
 *     pointer (/raw/ oid) — the gen-ai-model-manifest.mjs pattern, no
 *     multi-hundred-MB download.
 *
 * Fallbacks (sync mode only, never --check): an asset without an API digest
 * is downloaded + hashed locally when < 100 MB; the ~250–390 MB CUDA pair is
 * NEVER downloaded by this script — the maintainer hashes it once locally:
 *   node scripts/sync-native-engine.mjs --hash-file win-x64/cudart-12.4 <path>
 * (values supplied this way are cross-checked against the API digest when
 * one IS present — a mismatch is a hard error, not a silent accept).
 * `digestVerified: true` = hash came from the API; `false` = computed
 * locally. --check HARD-FAILS on any null/missing digest: the gate must
 * never pass on an unverified pin.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LLAMA_TAG = 'b11553';
const RELEASE_BASE = `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_TAG}`;
const DOWNLOAD_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;

// {manifestKey, asset} — the ONLY pinned binaries (D2/D4 scope). Everything
// else in a release (rocm/sycl/openvino/android/…) is deliberately ignored.
const ENGINE_ASSETS = [
  { key: 'win-x64/vulkan', asset: 'llama-b11553-bin-win-vulkan-x64.zip' },
  { key: 'win-x64/cuda-12.4', asset: 'llama-b11553-bin-win-cuda-12.4-x64.zip' },
  { key: 'macos-arm64/metal', asset: 'llama-b11553-bin-macos-arm64.tar.gz' },
  { key: 'macos-x64/metal', asset: 'llama-b11553-bin-macos-x64.tar.gz' },
  { key: 'linux-x64/vulkan', asset: 'llama-b11553-bin-ubuntu-vulkan-x64.tar.gz' },
  { key: 'linux-x64/cpu', asset: 'llama-b11553-bin-ubuntu-x64.tar.gz' },
];
const EXTRA_ASSETS = [
  { key: 'win-x64/cudart-12.4', asset: 'cudart-llama-bin-win-cuda-12.4-x64.zip' },
];
// >100 MB archives are never downloaded by this script (CUDA pair: hashed
// once by the maintainer via --hash-file; CI reads API digests only).
const MAX_FALLBACK_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const MODEL_REPO = 'ggml-org/GLM-OCR-GGUF';
const UPSTREAM_REPO = 'zai-org/GLM-OCR';
const MODEL_REVISION = '65a42de1148dbed2297e922b5dbc7d9b70c36578';
const MODEL_FILES = ['GLM-OCR-Q8_0.gguf', 'mmproj-GLM-OCR-Q8_0.gguf'];
const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0']);
// ubuntu builds (release.yml legs) target 22.04; apple legs set
// CMAKE_OSX_DEPLOYMENT_TARGET=13.3 (research-llamaserver-surface §4).
const MIN_GLIBC = '2.35';
const MIN_MACOS = '13.3';

const jsonFetch = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
};

async function licenseOf(repo) {
  const data = await jsonFetch(`https://huggingface.co/api/models/${repo}`);
  const tag = (data.tags ?? []).find((t) => t.startsWith('license:'));
  const license = tag ? tag.slice('license:'.length).toUpperCase() : null;
  if (!license || !ALLOWED_LICENSES.has(license)) {
    throw new Error(`${repo} license ${license} not in {${[...ALLOWED_LICENSES].join(', ')}} — refusing to pin`);
  }
  return license;
}

// LFS-pointer sha256 resolution — same shape as gen-ai-model-manifest.mjs.
async function ggufSha256Of(path) {
  const res = await fetch(`https://huggingface.co/${MODEL_REPO}/raw/${MODEL_REVISION}/${path}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HF raw ${path} → ${res.status}`);
  const raw = await res.text();
  const lfs = raw.match(/^oid sha256:([0-9a-f]{64})$/m);
  if (!lfs) throw new Error(`${path} has no LFS pointer at ${MODEL_REVISION}`);
  return lfs[1];
}

async function sha256File(path) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

async function downloadAndHash(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), sizeBytes: size };
}

async function releaseAssets() {
  const release = await jsonFetch(RELEASE_BASE);
  if (release.tag_name !== LLAMA_TAG) throw new Error(`release tag moved: ${release.tag_name}`);
  const map = new Map();
  for (const a of release.assets) {
    map.set(a.name, { sizeBytes: a.size, digest: a.digest ?? null });
  }
  return map;
}

function parseDigest(digest) {
  if (!digest) return null;
  const m = digest.match(/^sha256:([0-9a-f]{64})$/);
  return m ? m[1] : null;
}

async function engineEntry(assets, { key, asset }, localHashes) {
  const url = `${DOWNLOAD_BASE}/${asset}`;
  const info = assets.get(asset);
  if (!info) throw new Error(`asset ${asset} missing from release ${LLAMA_TAG}`);
  const apiSha = parseDigest(info.digest);
  const digestVerified = apiSha !== null;
  let sha256 = apiSha;
  if (sha256 === null && localHashes.has(key)) {
    sha256 = localHashes.get(key);
  }
  if (sha256 === null) {
    if (info.sizeBytes > MAX_FALLBACK_DOWNLOAD_BYTES) {
      throw new Error(
        `${asset} (${(info.sizeBytes / 1e6).toFixed(0)} MB) has no API digest and is too large to hash here — ` +
          `run: node scripts/sync-native-engine.mjs --hash-file ${key} <local-file>`,
      );
    }
    process.stderr.write(`  ${asset}: no API digest — downloading ${(info.sizeBytes / 1e6).toFixed(1)} MB to hash\n`);
    const got = await downloadAndHash(url);
    sha256 = got.sha256;
    if (got.sizeBytes !== info.sizeBytes) throw new Error(`${asset} size drift: ${got.sizeBytes} != ${info.sizeBytes}`);
  }
  return { asset, url, sha256, sizeBytes: info.sizeBytes, digestVerified };
}

async function buildManifest(localHashes) {
  const [assets, upstreamLicense] = await Promise.all([releaseAssets(), licenseOf(UPSTREAM_REPO)]);

  const engines = {};
  for (const entry of ENGINE_ASSETS) engines[entry.key] = await engineEntry(assets, entry, localHashes);
  const extras = {};
  for (const entry of EXTRA_ASSETS) extras[entry.key] = await engineEntry(assets, entry, localHashes);

  // GGUF pins from the HF tree at the pinned revision (LFS oids = sha256).
  const tree = await jsonFetch(`https://huggingface.co/api/models/${MODEL_REPO}/tree/${MODEL_REVISION}?recursive=true`);
  const files = [];
  for (const path of MODEL_FILES) {
    const f = tree.find((t) => t.type === 'file' && t.path === path);
    if (!f) throw new Error(`model file ${path} missing from ${MODEL_REPO}@${MODEL_REVISION}`);
    const lfsSha = f.lfs?.oid ?? (await ggufSha256Of(path));
    files.push({ path, sizeBytes: f.lfs?.size ?? f.size, sha256: lfsSha, digestVerified: true });
  }

  return {
    llamaTag: LLAMA_TAG,
    generatedAt: new Date().toISOString().slice(0, 10),
    minGlibc: MIN_GLIBC,
    minMacos: MIN_MACOS,
    engines,
    extras,
    model: {
      repo: MODEL_REPO,
      upstream: { repo: UPSTREAM_REPO, license: upstreamLicense },
      revision: MODEL_REVISION,
      files,
    },
  };
}

const PIN_FIELDS = (m) => ({ ...m, generatedAt: undefined });

// Field-level drift report (phase 1 success criterion: corrupting one sha256
// in the committed manifest must name the field, not just exit non-zero).
function driftPaths(a, b, path = '') {
  const out = [];
  if (a === b) return out;
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object';
  if (!bothObjects) {
    out.push(`${path || '<root>'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out.push(...driftPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return out;
}

async function main() {
  const check = process.argv.includes('--check');
  const hashFileIdx = process.argv.indexOf('--hash-file');
  const localHashes = new Map();
  if (hashFileIdx !== -1) {
    const key = process.argv[hashFileIdx + 1];
    const path = process.argv[hashFileIdx + 2];
    if (!key || !path) throw new Error('--hash-file <manifestKey> <local-file>');
    statSync(path); // throws if missing
    localHashes.set(key, await sha256File(path));
    if (check) throw new Error('--hash-file computes pins; it cannot run with --check');
  }

  const manifest = await buildManifest(localHashes);
  const out = fileURLToPath(new URL('./native-engine-manifest.json', import.meta.url));

  if (check) {
    // Hard gates, review F8: a null digestVerified anywhere means the pin is
    // unverified — the check fails instead of silently passing.
    const entries = [...Object.entries(manifest.engines), ...Object.entries(manifest.extras)];
    for (const [key, e] of entries) {
      if (!e.digestVerified || !/^[0-9a-f]{64}$/.test(e.sha256)) {
        console.error(`[sync-native-engine] CHECK FAILED — ${key}: pin is not API-digest-verified (digest null or malformed).`);
        process.exit(1);
      }
    }
    for (const f of manifest.model.files) {
      if (!f.digestVerified || !/^[0-9a-f]{64}$/.test(f.sha256)) {
        console.error(`[sync-native-engine] CHECK FAILED — model ${f.path}: unverified pin.`);
        process.exit(1);
      }
    }
    const current = readFileSync(out, 'utf8');
    const drift = driftPaths(PIN_FIELDS(JSON.parse(current)), PIN_FIELDS(manifest));
    if (drift.length > 0) {
      console.error('[sync-native-engine] DRIFT — committed manifest != pinned sources.');
      for (const d of drift) console.error(`  ${d}`);
      console.error('  Re-run `node scripts/sync-native-engine.mjs` and review the diff.');
      process.exit(1);
    }
    console.log('[sync-native-engine] check OK — manifest matches release + HF at pinned revisions.');
    return;
  }
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[sync-native-engine] wrote ${out}`);
}

main().catch((e) => {
  console.error('[sync-native-engine] FAILED:', e.message);
  process.exit(1);
});
