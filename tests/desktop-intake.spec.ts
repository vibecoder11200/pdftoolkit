// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Desktop intake adapter (phase 2). Seam choice: the real
 * @tauri-apps/api/core delegates to `window.__TAURI_INTERNALS__` — faking
 * the internals object (not the module) exercises the REAL api code paths.
 * Only the event/webview modules are module-mocked (their real impls are
 * invoke-plumbing heavy). The 500MB budget mirrors dir-picker (same
 * constant) and is not re-tested here.
 */

const KEY = '__TAURI_INTERNALS__';
const globals = globalThis as Record<string, unknown>;

const internals = vi.hoisted(() => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn(),
}));

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
}));
const webviewMock = vi.hoisted(() => ({
  getCurrentWebview: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => eventMock);
vi.mock('@tauri-apps/api/webview', () => webviewMock);

import { initDesktopIntake } from '../src/lib/desktop-intake';
import {
  takePendingFiles,
  clearPendingFiles,
  hasPendingFiles,
  appendPendingFiles,
} from '../src/lib/handoff';

type ListenHandler = (event: { payload: unknown }) => void;
const listenHandlers = new Map<string, ListenHandler>();
let dragHandler: ((event: { payload: { type: string } }) => void) | null = null;

beforeEach(() => {
  delete globals[KEY];
  listenHandlers.clear();
  dragHandler = null;
  clearPendingFiles();
  vi.clearAllMocks();
  internals.invoke.mockResolvedValue([]);
  internals.convertFileSrc.mockImplementation(
    (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
  );
  globals[KEY] = { invoke: internals.invoke, convertFileSrc: internals.convertFileSrc };
  eventMock.listen.mockImplementation(async (channel: string, handler: ListenHandler) => {
    listenHandlers.set(channel, handler);
    return () => listenHandlers.delete(channel);
  });
  webviewMock.getCurrentWebview.mockReturnValue({
    onDragDropEvent: async (handler: typeof dragHandler) => {
      dragHandler = handler;
      return () => {
        dragHandler = null;
      };
    },
  });
});

afterEach(() => {
  delete globals[KEY];
  clearPendingFiles();
});

function stubFetch(responses: Record<string, { ok: boolean; bytes?: number }>) {
  const fetchMock = vi.fn(async (url: string) => {
    const match = Object.keys(responses).find((k) => decodeURIComponent(url).includes(k));
    const spec = match ? responses[match] : { ok: false };
    return {
      ok: spec.ok,
      arrayBuffer: async () => new ArrayBuffer(spec.bytes ?? 4),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('initDesktopIntake', () => {
  it('is a no-op on the web (gate: no listeners, no invokes)', async () => {
    delete globals[KEY];
    const result = await initDesktopIntake({ onFiles: vi.fn() });
    expect(result).toBeUndefined();
    expect(eventMock.listen).not.toHaveBeenCalled();
    expect(internals.invoke).not.toHaveBeenCalled();
  });

  it('resolves to undefined when tauri modules fail to load', async () => {
    eventMock.listen.mockRejectedValue(new Error('no internals'));
    const result = await initDesktopIntake({ onFiles: vi.fn() });
    expect(result).toBeUndefined();
  });

  it('delivers emitted paths as File objects into the pending handoff', async () => {
    stubFetch({ 'report.pdf': { ok: true, bytes: 8 } });
    // consumer semantics: LaunchBanner feeds the handoff from onFiles
    await initDesktopIntake({ onFiles: (files) => appendPendingFiles(files) });

    const handler = listenHandlers.get('desktop://open-files');
    expect(handler).toBeDefined();
    handler!({ payload: ['D:\\docs\\report.pdf'] });

    // hasPendingFiles() observes without consuming (takePendingFiles mutates).
    await vi.waitFor(() => expect(hasPendingFiles()).toBe(true));
    const pending = takePendingFiles();
    expect(pending?.files).toHaveLength(1);
    expect(pending?.files[0].name).toBe('report.pdf');
    expect(pending?.files[0].size).toBe(8);
    expect(internals.convertFileSrc).toHaveBeenCalledWith('D:\\docs\\report.pdf', 'asset');
  });

  it('fetches cold-start argv files via initial_open_files', async () => {
    internals.invoke.mockResolvedValue(['/tmp/cold.pdf']);
    const fetchMock = stubFetch({ '/tmp/cold.pdf': { ok: true, bytes: 3 } });
    await initDesktopIntake({ onFiles: vi.fn() });
    // real api core passes (cmd, args, options) — assert the command only
    expect(internals.invoke.mock.calls[0]?.[0]).toBe('initial_open_files');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('drop channel delivers; non-ok fetches and junk payloads are skipped', async () => {
    const fetchMock = stubFetch({ 'good.pdf': { ok: true, bytes: 2 }, 'bad.pdf': { ok: false } });
    const onFiles = vi.fn();
    await initDesktopIntake({ onFiles });

    listenHandlers.get('desktop://drop-files')!({
      payload: ['D:/good.pdf', 'D:/bad.pdf', 42, null],
    });
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['good.pdf']);
  });

  it('wires the window drag highlight from onDragDropEvent', async () => {
    stubFetch({});
    const onDragHighlight = vi.fn();
    await initDesktopIntake({ onFiles: vi.fn(), onDragHighlight });
    expect(dragHandler).toBeDefined();
    dragHandler!({ payload: { type: 'enter' } });
    dragHandler!({ payload: { type: 'over' } });
    expect(onDragHighlight).toHaveBeenNthCalledWith(1, true);
    expect(onDragHighlight).toHaveBeenNthCalledWith(2, true);
    dragHandler!({ payload: { type: 'drop' } });
    dragHandler!({ payload: { type: 'leave' } });
    expect(onDragHighlight).toHaveBeenNthCalledWith(3, false);
    expect(onDragHighlight).toHaveBeenNthCalledWith(4, false);
  });

  it('the returned disposer unlistens every channel', async () => {
    stubFetch({});
    const dispose = await initDesktopIntake({
      onFiles: vi.fn(),
      onDragHighlight: vi.fn(),
    });
    expect(dispose).toBeTypeOf('function');
    dispose!();
    expect(listenHandlers.has('desktop://open-files')).toBe(false);
    expect(listenHandlers.has('desktop://drop-files')).toBe(false);
    expect(dragHandler).toBeNull();
  });
});
