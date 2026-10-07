// Phase 3 (R5/R6/D12): compose the Tauri updater manifest from ONE job — the
// 4 build legs run tauri-action with includeUpdaterJson:false (their racing
// delete+re-upload lost a darwin-aarch64 key in a real postmortem), upload
// only their artifacts + .sig files, and this script then assembles
// latest.json once, asserts the platform-key invariant, and uploads it.
//
// Asserts tag == package.json version (D12 — tauri.conf.json reads
// ../package.json at build time, so all three agree transitively).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'vibecoder11200/pdftoolkit';
const PLATFORM_PATTERNS = [
  { key: 'windows-x86_64', asset: /x64-setup\.exe$/ },
  { key: 'darwin-aarch64', asset: /aarch64\.app\.tar\.gz$/ },
  { key: 'darwin-x86_64', asset: /x64\.app\.tar\.gz$/ },
  { key: 'linux-x86_64', asset: /amd64\.AppImage$/ },
];

const gh = (args, opts = {}) =>
  execFileSync('gh', args, { encoding: 'utf8', ...opts });

const tag = process.argv[2] ?? process.argv.find((a) => a.startsWith('app-v'));
if (!tag || !tag.startsWith('app-v')) {
  console.error('usage: node scripts/build-latest-json.mjs app-v<version>');
  process.exit(1);
}
const version = tag.slice('app-v'.length);
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (version !== pkgVersion) {
  console.error(`version drift: tag ${tag} != package.json ${pkgVersion} (D12)`);
  process.exit(1);
}

const release = JSON.parse(gh(['release', 'view', tag, '--repo', REPO, '--json', 'assets,body']));
const assets = release.assets.map((a) => a.name);

const work = mkdtempSync(join(tmpdir(), 'latest-json-'));
const platforms = {};
for (const { key, asset } of PLATFORM_PATTERNS) {
  const name = assets.find((n) => asset.test(n));
  const sig = assets.find((n) => n === `${name}.sig`);
  if (!name || !sig) {
    console.error(`missing updater artifact for ${key}: "${name}" (sig: ${Boolean(sig)})`);
    process.exit(1);
  }
  gh(['release', 'download', tag, '--repo', REPO, '--pattern', sig, '--dir', work]);
  platforms[key] = {
    signature: readFileSync(join(work, sig), 'utf8').trim(),
    url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}
rmSync(work, { recursive: true, force: true });

if (Object.keys(platforms).length !== PLATFORM_PATTERNS.length) {
  console.error('platform-key invariant violated');
  process.exit(1);
}

const latest = {
  version,
  notes: 'PDF Toolkit desktop release. See the release page for checksums and install notes.',
  pub_date: new Date().toISOString(),
  platforms,
};
// The asset MUST be named exactly latest.json — the updater endpoint resolves
// releases/latest/download/latest.json, so a versioned name would 404.
const out = join(tmpdir(), 'latest.json');
writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`latest.json OK: ${Object.keys(platforms).join(', ')} → ${out}`);
gh(['release', 'upload', tag, '--repo', REPO, '--clobber', out]);
console.log('uploaded latest.json to the release');
