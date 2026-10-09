// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * desktop-update-store (v0.5.3 manual check): the updater phases moved from a
 * banner-local useState into a shared observable store so Settings can run an
 * on-demand check. Pinned here: the check outcomes (uptodate / available with
 * the remote version / honest check-error), the busy guards (a manual check
 * must never stomp an in-flight install, a second install click is a no-op —
 * F7), and the web no-op gate.
 */

const KEY = '__TAURI_INTERNALS__';
const globals = globalThis as Record<string, unknown>;

const updaterMock = vi.hoisted(() => ({ check: vi.fn() }));
const processMock = vi.hoisted(() => ({ relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => updaterMock);
vi.mock('@tauri-apps/plugin-process', () => processMock);

import {
  checkForDesktopUpdate,
  getDesktopUpdateState,
  resetDesktopUpdateStore,
  startDesktopUpdateInstall,
} from '../src/lib/desktop-update-store';

const STARTED = { event: 'Started', data: { contentLength: 100 } };

function fakeUpdate(events: Array<Record<string, unknown>>, holdMs = 0) {
  return {
    version: '9.9.9',
    downloadAndInstall: vi.fn(async (onEvent: (e: unknown) => void) => {
      for (const e of events) {
        onEvent(e);
        // Hold MID-download (after Started, before the rest) so a waitFor can
        // observe the 'downloading' phase before the flow resolves.
        if (e.event === 'Started' && holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      }
    }),
  };
}

beforeEach(() => {
  resetDesktopUpdateStore();
  vi.clearAllMocks();
  globals[KEY] = {};
  updaterMock.check.mockResolvedValue(null);
  processMock.relaunch.mockResolvedValue(undefined);
});

afterEach(() => {
  delete globals[KEY];
});

describe('checkForDesktopUpdate', () => {
  it('no update → uptodate, timestamped', async () => {
    await checkForDesktopUpdate();
    const s = getDesktopUpdateState();
    expect(s.phase).toBe('uptodate');
    expect(s.lastCheckedAt).toBeGreaterThan(0);
  });

  it('update found → available with the remote version', async () => {
    updaterMock.check.mockResolvedValue(fakeUpdate([]));
    await checkForDesktopUpdate();
    const s = getDesktopUpdateState();
    expect(s.phase).toBe('available');
    expect(s.availableVersion).toBe('9.9.9');
  });

  it('check failure → check-error carrying the REAL message (Settings-local, no banner)', async () => {
    updaterMock.check.mockRejectedValue(new Error('endpoint down'));
    await checkForDesktopUpdate();
    const s = getDesktopUpdateState();
    expect(s.phase).toBe('check-error');
    expect(s.message).toBe('endpoint down');
  });

  it('concurrent checks coalesce on the checking phase', async () => {
    let release!: () => void;
    updaterMock.check.mockReturnValue(
      new Promise<null>((r) => {
        release = () => r(null);
      }),
    );
    const first = checkForDesktopUpdate();
    const second = checkForDesktopUpdate();
    release();
    await Promise.all([first, second]);
    expect(updaterMock.check).toHaveBeenCalledTimes(1);
    expect(getDesktopUpdateState().phase).toBe('uptodate');
  });

  it('no-op on the web — never touches the plugin, phase stays idle', async () => {
    delete globals[KEY];
    await checkForDesktopUpdate();
    expect(updaterMock.check).not.toHaveBeenCalled();
    expect(getDesktopUpdateState()).toEqual({ phase: 'idle', percent: null });
  });
});

describe('startDesktopUpdateInstall', () => {
  it('runs the flow through progress to restarting', async () => {
    updaterMock.check.mockResolvedValue(fakeUpdate([STARTED, { event: 'Finished' }]));
    startDesktopUpdateInstall();
    await vi.waitFor(() => expect(getDesktopUpdateState().phase).toBe('restarting'));
  });

  it('a second start while installing is a no-op (F7 double-click guard)', async () => {
    updaterMock.check.mockResolvedValue(fakeUpdate([STARTED, { event: 'Finished' }], 50));
    startDesktopUpdateInstall();
    await vi.waitFor(() => expect(getDesktopUpdateState().phase).toBe('downloading'));
    startDesktopUpdateInstall();
    expect(updaterMock.check).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getDesktopUpdateState().phase).toBe('restarting'));
  });

  it('an in-flight install blocks a manual check from stomping it', async () => {
    updaterMock.check.mockResolvedValue(fakeUpdate([STARTED], 50));
    startDesktopUpdateInstall();
    await vi.waitFor(() => expect(getDesktopUpdateState().phase).toBe('downloading'));
    await checkForDesktopUpdate();
    expect(updaterMock.check).toHaveBeenCalledTimes(1); // only the flow's own check
    expect(getDesktopUpdateState().phase).toBe('downloading');
    await vi.waitFor(() => expect(getDesktopUpdateState().phase).toBe('restarting'));
  });
});
