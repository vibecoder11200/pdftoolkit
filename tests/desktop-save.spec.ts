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

import { saveBytesDesktop, saveBytesDesktopMulti } from '../src/lib/desktop-save';
import {
  canSaveElsewhere,
  deliverBytes,
  deliverBytesMulti,
} from '../src/lib/download';

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

describe('saveBytesDesktopMulti', () => {
  it('one dialog; siblings are written beside the picked file', async () => {
    internals.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin:dialog|save') return Promise.resolve('C:\\Users\\u\\Downloads\\doc-part1.pdf');
      if (cmd === 'plugin:fs|write_file') return Promise.resolve(null);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const ok = await saveBytesDesktopMulti([
      { bytes, filename: 'doc-part1.pdf' },
      { bytes, filename: 'doc-part2.pdf' },
      { bytes, filename: 'doc-part3.pdf' },
    ]);
    expect(ok).toBe(true);
    const writes = internals.invoke.mock.calls
      .filter((c) => c[0] === 'plugin:fs|write_file')
      .map((c) => decodeURIComponent((c[2] as { headers: { path: string } }).headers.path));
    expect(writes).toEqual([
      'C:\\Users\\u\\Downloads\\doc-part1.pdf',
      'C:\\Users\\u\\Downloads\\doc-part2.pdf',
      'C:\\Users\\u\\Downloads\\doc-part3.pdf',
    ]);
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

  it('deliverBytesMulti goes through one dialog on desktop', async () => {
    internals.invoke.mockImplementation((cmd: string) =>
      cmd === 'plugin:dialog|save' ? Promise.resolve('C:\\a-part1.pdf') : Promise.resolve(null),
    );
    const ok = await deliverBytesMulti([
      { bytes, filename: 'a-part1.pdf' },
      { bytes, filename: 'a-part2.pdf' },
    ]);
    expect(ok).toBe(true);
    expect(
      internals.invoke.mock.calls.filter((c) => c[0] === 'plugin:dialog|save'),
    ).toHaveLength(1);
  });
});

describe('canSaveElsewhere on desktop', () => {
  it('is false — the FSA toggle is a web-only affordance', () => {
    expect(canSaveElsewhere()).toBe(false);
  });
});
