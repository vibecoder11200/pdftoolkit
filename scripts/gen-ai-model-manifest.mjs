#!/usr/bin/env node
/*
 * gen-ai-model-manifest.mjs (v0.5.0 phase 2a, F21) — pins the AI OCR model
 * files: reads the HuggingFace API for the pinned commit-SHA revision and
 * emits scripts/ai-model-manifest.json (path, size, sha256 per file + license
 * of BOTH the ONNX repo and the upstream repo — two repos that can drift
 * independently, so both are asserted into the {MIT, Apache-2.0} allowlist).
 *
 * The committed manifest is the contract src/lib/ai-models.ts verifies the
 * Cache API copy against (D3). `--check` recomputes without writing and exits
 * non-zero on drift — the CI step guards pin == HF reality.
 *
 * Network: huggingface.co only (CI job). Large files resolve their sha256
 * from the LFS pointer (/raw/), NOT by downloading 650MB.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'onnx-community/GLM-OCR-ONNX';
const UPSTREAM_REPO = 'zai-org/GLM-OCR';
const REVISION = 'aea46198f09e3aa2b63422dd234f1cc66afffe52';
const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0']);
// q4f16 dtype selection (registry pin) + the small config/tokenizer files.
const Q4F16_PREFIXES = [
  'onnx/embed_tokens_q4f16.onnx',
  'onnx/vision_encoder_q4f16.onnx',
  'onnx/decoder_model_merged_q4f16.onnx',
];
const SMALL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'processor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'chat_template.jinja',
];

const api = async (path) => {
  const res = await fetch(`https://huggingface.co${path}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HF ${path} → ${res.status}`);
  return res;
};

async function licenseOf(repo) {
  const data = await api(`/api/models/${repo}`).then((r) => r.json());
  const tag = (data.tags ?? []).find((t) => t.startsWith('license:'));
  const license = tag ? tag.slice('license:'.length).toUpperCase() : null;
  if (!license || !ALLOWED_LICENSES.has(license)) {
    throw new Error(`${repo} license ${license} not in {${[...ALLOWED_LICENSES].join(', ')}} — refusing to pin`);
  }
  return license;
}

async function sha256Of(repo, revision, path) {
  // LFS pointer first (no download of multi-hundred-MB shards); fall back to
  // hashing the raw bytes for non-LFS files (small configs/tokenizer).
  const raw = await api(`/${repo}/raw/${revision}/${path}`).then((r) => r.text());
  const lfs = raw.match(/^oid sha256:([0-9a-f]{64})$/m);
  if (lfs) return lfs[1];
  const buf = await api(`/${repo}/resolve/${revision}/${path}`).then((r) => r.arrayBuffer());
  return createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

async function main() {
  const check = process.argv.includes('--check');
  const license = await licenseOf(REPO);
  const upstreamLicense = await licenseOf(UPSTREAM_REPO);

  const tree = await api(`/api/models/${REPO}/tree/${REVISION}?recursive=true`).then((r) => r.json());
  const wanted = tree.filter(
    (f) => f.type === 'file' && (Q4F16_PREFIXES.some((p) => f.path === p || f.path === `${p}_data`) || SMALL_FILES.includes(f.path)),
  );
  if (wanted.length === 0) throw new Error('HF tree returned no wanted files — API shape changed?');

  const files = [];
  for (const f of wanted) {
    files.push({ path: f.path, size: f.size, sha256: await sha256Of(REPO, REVISION, f.path) });
    process.stderr.write(`  ${f.path} (${(f.size / 1e6).toFixed(1)} MB)\n`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    repo: REPO,
    revision: REVISION,
    license,
    upstream: { repo: UPSTREAM_REPO, license: upstreamLicense },
    generatedAt: new Date().toISOString().slice(0, 10),
    files,
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const out = fileURLToPath(new URL('./ai-model-manifest.json', import.meta.url));

  if (check) {
    const current = readFileSync(out, 'utf8');
    if (current !== json) {
      console.error('[gen-ai-model-manifest] DRIFT — committed manifest != HF at pinned revision.');
      console.error('  Re-run `node scripts/gen-ai-model-manifest.mjs` and review the diff (license + revision + files).');
      process.exit(1);
    }
    console.log('[gen-ai-model-manifest] check OK — manifest matches HF at pinned revision.');
    return;
  }
  writeFileSync(out, json);
  console.log(`[gen-ai-model-manifest] wrote ${out} (${files.length} files)`);
}

main().catch((e) => {
  console.error('[gen-ai-model-manifest] FAILED:', e.message);
  process.exit(1);
});
