import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/*
 * Phase-3 API purity gates:
 * 1. Preset persistence stores FILES NOWHERE — runtime artifacts (File
 *    handles, bytes, reports) never enter presets.ts / preset-session.ts.
 * 2. The save-writer IPC never leaks a password/report into persistent
 *    config, and never accepts a write-path parameter (basename + token
 *    only — structural confinement).
 */

const read = (p: string) => readFileSync(p, 'utf8');

describe('preset purity (runtime files never persist)', () => {
  const presetFiles = ['src/lib/presets.ts', 'src/lib/preset-session.ts'];

  it('preset modules import no File/deliver/artifact surface', () => {
    for (const f of presetFiles) {
      const src = read(f);
      // the frozen handoff contract is the ONLY allowed file channel
      expect(src).not.toMatch(/deliverBytes|DeliveryReport|artifactRegistry|use-delivery/);
      expect(src).not.toMatch(/\bnew Blob\(/);
      expect(src).not.toMatch(/localStorage\.setItem\([^)]*\bbytes\b/);
    }
  });

  it('preset records carry no File/bytes-typed fields', () => {
    const src = read('src/lib/presets.ts');
    expect(src).not.toMatch(/:\s*File\b/);
    expect(src).not.toMatch(/:\s*Uint8Array\b/);
  });
});

describe('save-writer IPC purity (no path-addressable writes)', () => {
  it('desktop-save write commands carry token + basename + raw body only', () => {
    const src = read('src/lib/desktop-save.ts');
    expect(src).toContain('save_session_write');
    expect(src).toContain('encodeURIComponent(e.filename)');
    // no absolute-path argument on any write command
    expect(src).not.toMatch(/save_session_write[^(]*\(\s*[^,)]*path/i);
  });

  it('the Rust writer never consumes a path in a write command', () => {
    const rs = read('src-tauri/src/save_writer.rs');
    // save_session_write takes only the Request (headers: token+name)
    const writeFn = rs.slice(rs.indexOf('pub async fn save_session_write'), rs.indexOf('pub async fn save_session_end'));
    expect(writeFn).not.toContain('path:');
    expect(writeFn).toContain('InvokeBody::Raw');
    // begin is the ONLY place a path crosses
    expect(rs.indexOf('state.begin(&path)')).toBeGreaterThan(-1);
  });

  it('no password/report bytes flow to persistent config', () => {
    const lib = read('src-tauri/src/lib.rs');
    // commands are REGISTERED (expected) but the only persistent-config
    // write remains the boolean-only gpu flag file (SEC-1).
    expect(lib).toContain('save_writer::save_session_write');
    expect(lib).toContain('set_gpu_force');
    const flagFn = lib.slice(lib.indexOf('fn set_gpu_force'), lib.indexOf('fn get_gpu_force'));
    expect(flagFn).toContain('\"{\\\"force\\\":true}\"');
    expect(flagFn).toContain('\"{\\\"force\\\":false}\"');
    expect(flagFn).not.toMatch(/format!\(|request|report/i);
  });
});

describe('source purity boundary (tests never import src internals)', () => {
  it('delivery modules keep the worker/main split (no Buffer in browser sections)', () => {
    for (const f of ['src/lib/delivery-report.ts', 'src/lib/delivery-names.ts', 'src/lib/use-delivery.ts']) {
      expect(read(f)).not.toMatch(/\bBuffer\./);
    }
  });
});
