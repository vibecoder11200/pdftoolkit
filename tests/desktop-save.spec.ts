// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Desktop save adapter (rc probe follow-up). Same seam as desktop-intake:
 * the plugin JS packages delegate to `window.__TAURI_INTERNALS__.invoke`,
 * so faking the internals object exercises the REAL plugin-dialog/plugin-fs
 * guest code paths (channel names included) without a Tauri host.
 */

const KEY = '__TAURI_INTERNALS__';
const globals = globalThis as Record<string, unknown>;

const internals = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

import { saveBytesDesktop, saveSessionMulti } from '../src/lib/desktop-save';
import {
  canSaveElsewhere,
  deliverBytes,
  deliverBytesMulti,
} from '../src/lib/download';

const sessionFs = () => (cmd: string) => {
  if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\Users\\u\\Documents');
  if (cmd === 'save_session_begin') return Promise.resolve({ token: 'tok' });
  if (cmd === 'save_session_write') return Promise.resolve({ ok: true });
  if (cmd === 'save_session_end') return Promise.resolve(null);
  throw new Error(`unexpected command: ${cmd}`);
};

beforeEach(() => {
  delete globals[KEY];
  vi.clearAllMocks();
  globals[KEY] = { invoke: internals.invoke };
});

afterEach(() => {
  delete globals[KEY];
});

const bytes = new Uint8Array([1, 2, 3, 4]);

describe('saveBytesDesktop', () => {
  it('picks a path via plugin:dialog|save and writes via plugin:fs|write_file', async () => {
    internals.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin:dialog|save') return Promise.resolve('C:\\Users\\u\\Desktop\\out.pdf');
      if (cmd === 'plugin:fs|write_file') return Promise.resolve(null);
      throw new Error(`unexpected command: ${cmd}`);
    });
    await expect(saveBytesDesktop(bytes, 'out.pdf')).resolves.toBe(true);
    // dialog guest: invoke(cmd, { options }); fs guest: invoke(cmd, data,
    // { headers: { path } }) — raw-bytes IPC with the path in a header.
    const saveCmd = internals.invoke.mock.calls.find((c) => c[0] === 'plugin:dialog|save');
    expect((saveCmd?.[1] as { options: { defaultPath: string } }).options.defaultPath).toBe('out.pdf');
    const writeCmd = internals.invoke.mock.calls.find((c) => c[0] === 'plugin:fs|write_file');
    expect(
      decodeURIComponent(
        (writeCmd?.[2] as { headers: { path: string } }).headers.path,
      ),
    ).toBe('C:\\Users\\u\\Desktop\\out.pdf');
    expect(new Uint8Array(writeCmd?.[1] as ArrayBuffer).length).toBe(bytes.length);
  });

  it('cancel (null path) resolves false and never touches the fs plugin', async () => {
    internals.invoke.mockImplementation((cmd: string) =>
      cmd === 'plugin:dialog|save' ? Promise.resolve(null) : Promise.resolve(null),
    );
    await expect(saveBytesDesktop(bytes, 'out.pdf')).resolves.toBe(false);
    expect(internals.invoke.mock.calls.some((c) => c[0] === 'plugin:fs|write_file')).toBe(false);
  });

  it('write failures propagate (parity with the web picker contract)', async () => {
    internals.invoke.mockImplementation((cmd: string) =>
      cmd === 'plugin:dialog|save'
        ? Promise.resolve('C:\\x.pdf')
        : Promise.reject(new Error('denied')),
    );
    await expect(saveBytesDesktop(bytes, 'x.pdf')).rejects.toThrow('denied');
  });
});

describe('saveSessionMulti (phase-3 session writer)', () => {
  it('one directory pick; siblings ride per-entry writes as raw bytes + name header', async () => {
    internals.invoke.mockImplementation(sessionFs());
    const report = await saveSessionMulti([
      { bytes, filename: 'doc-part1.pdf' },
      { bytes, filename: 'doc-part2.pdf' },
      { bytes, filename: 'doc-part3.pdf' },
    ]);
    expect(report.overall).toBe('complete');
    const writes = internals.invoke.mock.calls.filter((c) => c[0] === 'save_session_write');
    expect(writes).toHaveLength(3);
    const names = writes.map((c) =>
      decodeURIComponent((c[2] as { headers: { name: string } }).headers.name),
    );
    expect(names).toEqual(['doc-part1.pdf', 'doc-part2.pdf', 'doc-part3.pdf']);
    // bytes ride the raw body (plugin-fs raw-body invoke pattern)
    expect(new Uint8Array(writes[0]?.[1] as ArrayBuffer).length).toBe(bytes.length);
    // path never crosses the write IPC
    expect(writes.every((c) => JSON.stringify(c[1]).includes('C:'))).toBe(false);
    expect(internals.invoke.mock.calls.at(-1)?.[0]).toBe('save_session_end');
  });

  it('cancelled pick → cancelled report, no session commands', async () => {
    internals.invoke.mockImplementation((cmd: string) =>
      cmd === 'plugin:dialog|open' ? Promise.resolve(null) : Promise.resolve(null),
    );
    const report = await saveSessionMulti([{ bytes, filename: 'a.pdf' }]);
    expect(report.overall).toBe('cancelled');
    expect(internals.invoke.mock.calls.some((c) => c[0].startsWith('save_session_'))).toBe(false);
  });

  it('end runs in finally even when a write rejects', async () => {
    internals.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\d');
      if (cmd === 'save_session_begin') return Promise.resolve({ token: 'tok' });
      if (cmd === 'save_session_write') return Promise.reject(new Error('disk full'));
      if (cmd === 'save_session_end') return Promise.resolve(null);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const report = await saveSessionMulti([
      { bytes, filename: 'a.pdf' },
      { bytes, filename: 'b.pdf' },
    ]);
    expect(report.overall).toBe('failed');
    expect(report.entries.every((e) => e.status === 'failed' && e.error === 'disk full')).toBe(true);
    expect(internals.invoke.mock.calls.at(-1)?.[0]).toBe('save_session_end');
  });
});

describe('deliverBytes desktop routing', () => {
  it('ignores dest and routes through the native dialog when in Tauri', async () => {
    internals.invoke.mockImplementation((cmd: string) =>
      cmd === 'plugin:dialog|save' ? Promise.resolve('C:\\o.pdf') : Promise.resolve(null),
    );
    await expect(deliverBytes(bytes, 'o.pdf', 'download')).resolves.toBe(true);
    expect(internals.invoke.mock.calls.some((c) => c[0] === 'plugin:dialog|save')).toBe(true);
  });

  it('deliverBytesMulti picks ONE directory via the folder dialog on desktop', async () => {
    internals.invoke.mockImplementation(sessionFs());
    const report = await deliverBytesMulti([
      { bytes, filename: 'a-part1.pdf' },
      { bytes, filename: 'a-part2.pdf' },
    ]);
    expect(report.overall).toBe('complete');
    expect(
      internals.invoke.mock.calls.filter((c) => c[0] === 'plugin:dialog|open'),
    ).toHaveLength(1);
    expect(internals.invoke.mock.calls.some((c) => c[0] === 'plugin:dialog|save')).toBe(false);
  });
});

describe('canSaveElsewhere on desktop', () => {
  it('is false — the FSA toggle is a web-only affordance', () => {
    expect(canSaveElsewhere()).toBe(false);
  });
});
