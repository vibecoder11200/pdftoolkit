// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Desktop updater flow (phase 3, D5/R10): progress events, the Windows
 * fire-and-forget relaunch (the NSIS installer kills the running app, so
 * awaiting relaunch() is a trap), and the awaited relaunch elsewhere.
 */

const KEY = '__TAURI_INTERNALS__';
const globals = globalThis as Record<string, unknown>;

const updaterMock = vi.hoisted(() => ({ check: vi.fn() }));
const processMock = vi.hoisted(() => ({ relaunch: vi.fn() }));

vi.mock('@tauri-apps/plugin-updater', () => updaterMock);
vi.mock('@tauri-apps/plugin-process', () => processMock);

import { isWindows, runDesktopUpdateFlow, type DesktopUpdateState } from '../src/lib/desktop-updater';

const states: DesktopUpdateState[] = [];

function fakeUpdate(events: Array<Record<string, unknown>>) {
  return {
    downloadAndInstall: vi.fn(async (onEvent: (e: unknown) => void) => {
      for (const e of events) onEvent(e);
    }),
  };
}

beforeEach(() => {
  states.length = 0;
  vi.clearAllMocks();
  globals[KEY] = {};
  updaterMock.check.mockResolvedValue(fakeUpdate([]));
  processMock.relaunch.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 Macintosh' });
});

afterEach(() => {
  delete globals[KEY];
  vi.unstubAllGlobals();
});

describe('runDesktopUpdateFlow', () => {
  it('reports up-to-date (back to idle) when check() finds nothing', async () => {
    updaterMock.check.mockResolvedValue(null);
    await runDesktopUpdateFlow((s) => states.push(s));
    expect(states).toEqual([{ phase: 'idle', percent: null }]);
    expect(processMock.relaunch).not.toHaveBeenCalled();
  });

  it('streams download progress and restarts (awaited) on non-Windows', async () => {
    updaterMock.check.mockResolvedValue(
      fakeUpdate([
        { event: 'Started', data: { contentLength: 100 } },
        { event: 'Progress', data: { chunkLength: 40 } },
        { event: 'Progress', data: { chunkLength: 40 } },
        { event: 'Finished' },
      ]),
    );
    await runDesktopUpdateFlow((s) => states.push(s));
    expect(updaterMock.check).toHaveBeenCalled();
    expect(states.map((s) => s.phase)).toEqual([
      'downloading',
      'downloading',
      'downloading',
      'installing',
      'restarting',
    ]);
    expect(states[1].percent).toBe(40);
    expect(states[2].percent).toBe(80);
    expect(processMock.relaunch).toHaveBeenCalledTimes(1);
  });

  it('is fire-and-forget on Windows: relaunch() is called without awaiting it', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 Windows NT 10.0' });
    expect(isWindows()).toBe(true);
    let releaseRelaunch: ((v: unknown) => void) | undefined;
    processMock.relaunch.mockReturnValue(
      new Promise((resolve) => {
        releaseRelaunch = resolve;
      }),
    );
    updaterMock.check.mockResolvedValue(fakeUpdate([{ event: 'Finished' }]));
    const flow = runDesktopUpdateFlow((s) => states.push(s));
    // The flow must move past relaunch WITHOUT it settling (R10 — the
    // installer kills the process; an await here never returns).
    await vi.waitFor(() => expect(processMock.relaunch).toHaveBeenCalled());
    expect(states.at(-1)).toEqual({ phase: 'restarting', percent: null });
    releaseRelaunch?.(undefined);
    await flow;
  });

  it('maps failures to the error phase with the message surfaced (phase 6, F7) and never throws', async () => {
    updaterMock.check.mockRejectedValue(new Error('endpoint down'));
    await expect(runDesktopUpdateFlow((s) => states.push(s))).resolves.toBeUndefined();
    expect(states).toEqual([{ phase: 'error', percent: null, message: 'endpoint down' }]);
    // Non-Error throws degrade to a string message, not a swallowed catch.
    updaterMock.check.mockRejectedValue('plain string failure');
    await runDesktopUpdateFlow((s) => states.push(s));
    expect(states.at(-1)).toEqual({ phase: 'error', percent: null, message: 'plain string failure' });
  });
});
