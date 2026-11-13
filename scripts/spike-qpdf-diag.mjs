// Phase-8 spike: ACTUAL qpdf-wasm behavior on damaged/recoverable/
// unrecoverable/encrypted inputs. Captures stdout+stderr via print hooks,
// records exit codes + output sizes + bounded stderr tails into
// plans/261112-0955-full-document-workflows-reviewed/reports/qpdf-diagnostic-spike.md
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = new Uint8Array(readFileSync(join(root, 'tests/fixtures/fixture-small.pdf')));

const sink = { out: [], err: [] };
const modFactory = (await import('@neslinesli93/qpdf-wasm')).default;
const inst = await modFactory({
  noInitialRun: true,
  print: (s) => sink.out.push(String(s)),
  printErr: (s) => sink.err.push(String(s)),
});
const FS = inst.FS;
const callMain = inst.callMain.bind(inst);
let seq = 0;
const tmp = (ext) => '/tmp/spike-' + Date.now() + '-' + (++seq) + '.' + ext;

function drain() {
  const out = sink.out.splice(0).join('\n');
  const err = sink.err.splice(0).join('\n');
  return { out, err };
}

function readIfPresent(p) {
  try { return FS.readFile(p).length; } catch { return -1; }
}

function run(args, label) {
  sink.out.length = 0; sink.err.length = 0;
  let code;
  try { code = callMain(args); } catch (e) { code = 'THROW:' + String(e).slice(0, 80); }
  const { out, err } = drain();
  return { label, code, outTail: out.slice(-400), errTail: err.slice(-400) };
}

const latin1 = (b) => Buffer.from(b).toString('latin1');
const fromLatin1 = (s) => new Uint8Array(Buffer.from(s, 'latin1'));

// ---- damaged variants -------------------------------------------------
const variants = {};
variants.healthy = fixture;
variants.truncated = fixture.slice(0, Math.floor(fixture.length * 0.55));
{
  const s = latin1(fixture);
  const i = s.lastIndexOf('startxref');
  const j = s.indexOf('\n', i);
  const k = s.indexOf('\n', j + 1);
  const broken = s.slice(0, j + 1) + '99999999' + s.slice(k);
  variants.startxref_corrupt = fromLatin1(broken);
}
variants.garbage_appended = (() => {
  const b = new Uint8Array(fixture.length + 256);
  b.set(fixture, 0);
  for (let i = 0; i < 256; i++) b[fixture.length + i] = (i * 37 + 11) & 255;
  return b;
})();
variants.not_a_pdf = new TextEncoder().encode('this is definitely not a pdf at all');
// encrypted (user=owner=spark) produced by qpdf itself
variants.encrypted_nopass = (() => {
  const inP = tmp('in.pdf'); const outP = tmp('enc.pdf');
  FS.writeFile(inP, fixture);
  const r = run(['--encrypt', 'spark', 'spark', '256', '--', inP, outP], 'encrypt');
  let bytes = null;
  try { bytes = FS.readFile(outP).slice(); } catch { /* no output */ }
  try { FS.unlink(inP); } catch {} try { FS.unlink(outP); } catch {}
  if (!bytes) throw new Error('encrypt fixture failed: ' + JSON.stringify(r));
  return bytes;
})();

// ---- check + rewrite matrix -------------------------------------------
const rows = [];
for (const [name, bytes] of Object.entries(variants)) {
  const inP = tmp('in.pdf'); const outP = tmp('out.pdf');
  FS.writeFile(inP, bytes);
  const check = run(['--check', inP], name + ' --check');
  const checkWithPass = name === 'encrypted_nopass'
    ? run(['--password=spark', '--check', inP], name + ' --check --password=spark')
    : null;
  const rewrite = run(['--', inP, outP], name + ' rewrite');
  const outSize = readIfPresent(outP);
  try { FS.unlink(outP); } catch {}
  const rewriteQdf = run(['--qdf', '--object-streams=disable', '--', inP, outP], name + ' rewrite-qdf');
  const qdfSize = readIfPresent(outP);
  try { FS.unlink(inP); } catch {} try { FS.unlink(outP); } catch {}
  rows.push({ name, size: bytes.length, check, checkWithPass, rewrite, outSize, rewriteQdf, qdfSize });
}

let md = '# qpdf diagnostics spike (actual wasm matrix)\n\nDate: 2026-11-13.\n';
md += 'Environment: node + @neslinesli93/qpdf-wasm (same build the app ships), print/printErr hooks captured per call.\n\n';
md += '| variant | size | --check exit | check stderr tail | rewrite exit | out bytes | qdf rewrite exit | qdf out bytes |\n';
md += '|---|---|---|---|---|---|---|---|\n';
for (const r of rows) {
  const errTail = (r.check.errTail || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(-120);
  md += '| ' + r.name + ' | ' + r.size + ' | ' + r.check.code + ' | ' + (errTail || '(none)') + ' | ' + r.rewrite.code + ' | ' + r.outSize + ' | ' + r.rewriteQdf.code + ' | ' + r.qdfSize + ' |\n';
}
md += '\n## Encrypted detail\n\n';
const enc = rows.find((r) => r.name === 'encrypted_nopass');
if (enc) {
  md += '- --check WITHOUT password: exit ' + enc.check.code + ' stderr: ' + (enc.check.errTail || '(none)').slice(-200) + '\n';
  if (enc.checkWithPass) md += '- --check WITH --password=spark: exit ' + enc.checkWithPass.code + ' stderr: ' + (enc.checkWithPass.errTail || '(none)').slice(-200) + '\n';
}
md += '\n## stdout captures (tails)\n\n';
for (const r of rows) {
  md += '- ' + r.name + ' check out: ' + (r.check.outTail || '(none)').replace(/\n/g, ' | ').slice(-200) + '\n';
}
const dir = join(root, 'plans/261112-0955-full-document-workflows-reviewed/reports');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'qpdf-diagnostic-spike.md'), md);
console.log(md.slice(0, 2600));
