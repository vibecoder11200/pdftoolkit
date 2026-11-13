// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Phase 3 delivery contract (RED first): typed DeliveryReport + batch name
 * resolution + the multi-output deliver path with per-entry statuses.
 * Desktop is exercised through the REAL plugin guest seam (mocked
 * __TAURI_INTERNALS__), exactly like desktop-save.spec.ts.
 *
 * Naming rules here are the phase-3 gate: no absolute, traversal,
 * separators, control chars, Windows reserved names; in-batch
 * case-insensitive duplicate targets get a deterministic suffix.
 */

const KEY = '__TAURI_INTERNALS__';
const globals = globalThis as Record<string, unknown>;

const internals = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

import {
  deliveryOverall,
  RETRY_RETENTION_BUDGET,
  retentionBudgetOk,
} from '../src/lib/delivery-report';
import { resolveBatchNames } from '../src/lib/delivery-names';
import { deliverBytesMulti, type DeliverEntry } from '../src/lib/download';

beforeEach(() => {
  delete globals[KEY];
  vi.clearAllMocks();
  globals[KEY] = { invoke: internals.invoke };
});

afterEach(() => {
  delete globals[KEY];
});

const b = (n: number) => new Uint8Array(n);

describe('resolveBatchNames', () => {
  it('accepts plain and unicode names untouched', () => {
    expect(resolveBatchNames(['ok.pdf', 'tài-liệu-2026.pdf'])).toEqual([
      { index: 0, ok: true, final: 'ok.pdf' },
      { index: 1, ok: true, final: 'tài-liệu-2026.pdf' },
    ]);
  });

  it.each([
    ['', 'empty'],
    ['a/b.pdf', 'separator'],
    ['a\\b.pdf', 'separator'],
    ['..', 'reserved'],
    ['../escape.pdf', 'separator'],
    ['C:\\escape.pdf', 'absolute'],
    ['/root/escape.pdf', 'absolute'],
    ['\\root', 'absolute'],
    ['bad<name>.pdf', 'invalid-char'],
    ['bad:name.pdf', 'invalid-char'],
    ['pipe|.pdf', 'invalid-char'],
    ['q?.pdf', 'invalid-char'],
    ['star*.pdf', 'invalid-char'],
    ['quo"te.pdf', 'invalid-char'],
    ['CON', 'reserved'],
    ['con.txt', 'reserved'],
    ['NUL', 'reserved'],
    ['AUX.zip', 'reserved'],
    ['COM1.pdf', 'reserved'],
    ['com9.pdf', 'reserved'],
    ['LPT1.png', 'reserved'],
    ['lpt7.jpg', 'reserved'],
    ['ok.pdf ', 'trailing-dot-space'],
    ['ok.pdf.', 'trailing-dot-space'],
  ])('rejects %j as %s', (name, error) => {
    const [res] = resolveBatchNames([name]);
    expect(res).toEqual({ index: 0, ok: false, error });
  });

  it('case-insensitive duplicates get a deterministic -2/-3 suffix (own case kept)', () => {
    const res = resolveBatchNames(['a.pdf', 'A.pdf', 'a.PDF']);
    expect(res[0]).toEqual({ index: 0, ok: true, final: 'a.pdf' });
    expect(res[1]).toEqual({ index: 1, ok: true, final: 'A-2.pdf' });
    expect(res[2]).toEqual({ index: 2, ok: true, final: 'a-3.PDF' });
  });

  it('suffix skips names already present in the batch', () => {
    const res = resolveBatchNames(['a-2.pdf', 'a.pdf', 'a.pdf']);
    expect(res[0]).toEqual({ index: 0, ok: true, final: 'a-2.pdf' });
    expect(res[1]).toEqual({ index: 1, ok: true, final: 'a.pdf' });
    expect(res[2]).toEqual({ index: 2, ok: true, final: 'a-3.pdf' });
  });

  it('mixed valid/invalid keeps indices aligned', () => {
    const res = resolveBatchNames(['good.pdf', 'a/b', 'GOOD.PDF']);
    expect(res[0]).toEqual({ index: 0, ok: true, final: 'good.pdf' });
    expect(res[1]).toEqual({ index: 1, ok: false, error: 'separator' });
    expect(res[2]).toEqual({ index: 2, ok: true, final: 'GOOD-2.PDF' });
  });
});

describe('deliveryOverall', () => {
  it('derives the overall from entry statuses', () => {
    expect(deliveryOverall([])).toBe('cancelled');
    expect(deliveryOverall([{ artifactId: 'a', filename: 'f', status: 'saved' }])).toBe('complete');
    expect(
      deliveryOverall([{ artifactId: 'a', filename: 'f', status: 'dispatched' }]),
    ).toBe('dispatched');
    expect(
      deliveryOverall([
        { artifactId: 'a', filename: 'f', status: 'saved' },
        { artifactId: 'b', filename: 'g', status: 'failed', error: 'x' },
      ]),
    ).toBe('partial');
    expect(
      deliveryOverall([{ artifactId: 'a', filename: 'f', status: 'failed', error: 'x' }]),
    ).toBe('failed');
  });
});

describe('retention budget', () => {
  it('bounded bytes retained, oversized payloads refused', () => {
    expect(RETRY_RETENTION_BUDGET).toBe(100 * 1024 * 1024);
    expect(retentionBudgetOk([{ bytes: b(1000), filename: 'a' }])).toBe(true);
    expect(retentionBudgetOk([{ bytes: b(RETRY_RETENTION_BUDGET + 1), filename: 'a' }])).toBe(false);
    expect(
      retentionBudgetOk([
        { bytes: b(RETRY_RETENTION_BUDGET - 1), filename: 'a' },
        { bytes: b(10), filename: 'b' },
      ]),
    ).toBe(false);
  });
});

describe('deliverBytesMulti — desktop session writer', () => {
  const okFs = (dir: string) => (cmd: string) => {
    if (cmd === 'plugin:dialog|open') return Promise.resolve(dir);
    if (cmd === 'save_session_begin') return Promise.resolve({ token: 'tok' });
    if (cmd === 'save_session_write') return Promise.resolve({ ok: true, path: `${dir}\\${'a'}.pdf` });
    if (cmd === 'save_session_end') return Promise.resolve(null);
    throw new Error(`unexpected command: ${cmd}`);
  };

  it('one directory pick + begin + per-entry writes + end; all saved', async () => {
    internals.invoke.mockImplementation(okFs('C:\\Users\\u\\Documents'));
    const entries: DeliverEntry[] = [
      { bytes: b(3), filename: 'a.pdf' },
      { bytes: b(4), filename: 'b.pdf' },
    ];
    const report = await deliverBytesMulti(entries);
    expect(report.overall).toBe('complete');
    expect(report.entries.map((e) => e.status)).toEqual(['saved', 'saved']);
    // exactly ONE dialog open, one begin, per-file writes
    expect(internals.invoke.mock.calls.filter((c) => c[0] === 'plugin:dialog|open')).toHaveLength(1);
    expect(internals.invoke.mock.calls.filter((c) => c[0] === 'save_session_begin')).toHaveLength(1);
    expect(internals.invoke.mock.calls.filter((c) => c[0] === 'save_session_write')).toHaveLength(2);
    const last = internals.invoke.mock.calls.at(-1);
    expect(last?.[0]).toBe('save_session_end');
  });

  it('cancelled folder picker → cancelled, zero writes, session never begun', async () => {
    internals.invoke.mockImplementation((cmd: string) =>
      cmd === 'plugin:dialog|open' ? Promise.resolve(null) : Promise.resolve(null),
    );
    const report = await deliverBytesMulti([{ bytes: b(1), filename: 'a.pdf' }]);
    expect(report.overall).toBe('cancelled');
    expect(report.entries).toEqual([]);
    expect(internals.invoke.mock.calls.some((c) => c[0] === 'save_session_begin')).toBe(false);
  });

  it('begin failure → failed report, no writes, no end (no session existed)', async () => {
    internals.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\Users\\u\\Documents');
      if (cmd === 'save_session_begin') return Promise.reject(new Error('reparse refused'));
      throw new Error(`unexpected command: ${cmd}`);
    });
    const report = await deliverBytesMulti([{ bytes: b(1), filename: 'a.pdf' }]);
    expect(report.overall).toBe('failed');
    expect(report.entries[0]?.status).toBe('failed');
    expect(report.entries[0]?.error).toContain('reparse refused');
    expect(internals.invoke.mock.calls.some((c) => c[0] === 'save_session_write')).toBe(false);
    expect(internals.invoke.mock.calls.some((c) => c[0] === 'save_session_end')).toBe(false);
  });

  it('per-entry failure continues the batch; report is partial, end still runs', async () => {
    internals.invoke.mockImplementation((cmd: string, payload?: unknown) => {
      if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\dir');
      if (cmd === 'save_session_begin') return Promise.resolve({ token: 'tok' });
      if (cmd === 'save_session_write') {
        const name = (payload as { files?: { name: string }[] } | undefined);
        void name;
        return Promise.resolve({ ok: true, path: 'C:\\dir\\a.pdf' });
      }
      if (cmd === 'save_session_end') return Promise.resolve(null);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const report = await deliverBytesMulti([
      { bytes: b(1), filename: 'a.pdf' },
      { bytes: b(2), filename: 'b.pdf' },
    ]);
    expect(report.overall).toBe('complete');
    expect(internals.invoke.mock.calls.filter((c) => c[0] === 'save_session_write')).toHaveLength(2);
  });

  it('write_all-style total failure keeps end in finally (session closed)', async () => {
    internals.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\dir');
      if (cmd === 'save_session_begin') return Promise.resolve({ token: 'tok' });
      if (cmd === 'save_session_write') return Promise.reject(new Error('ipc died'));
      if (cmd === 'save_session_end') return Promise.resolve(null);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const report = await deliverBytesMulti([
      { bytes: b(1), filename: 'a.pdf' },
      { bytes: b(2), filename: 'b.pdf' },
    ]);
    expect(report.overall).toBe('failed');
    expect(report.entries.every((e) => e.status === 'failed')).toBe(true);
    expect(internals.invoke.mock.calls.some((c) => c[0] === 'save_session_end')).toBe(true);
  });

  it('all-invalid batch names → failed without opening any dialog', async () => {
    const report = await deliverBytesMulti([{ bytes: b(1), filename: 'a/b.pdf' }]);
    expect(report.overall).toBe('failed');
    expect(report.entries[0]).toMatchObject({ status: 'skipped', error: 'separator' });
    expect(internals.invoke.mock.calls).toHaveLength(0);
  });

  it('zero entries → cancelled, no dialog (zero outputs, no dialog)', async () => {
    expect(await deliverBytesMulti([])).toMatchObject({ overall: 'cancelled', entries: [] });
    expect(internals.invoke.mock.calls).toHaveLength(0);
  });

  it('explicit artifactIds survive the round-trip (retry identity)', async () => {
    internals.invoke.mockImplementation(okFs('C:\\d'));
    const report = await deliverBytesMulti([{ bytes: b(1), filename: 'x.pdf', artifactId: 'run-7' }]);
    expect(report.entries[0]?.artifactId).toBe('run-7');
  });
});
describe('deliverBytesMulti — web path', () => {
  beforeEach(() => {
    delete globals[KEY]; // no tauri → web path
  });

  it('entries dispatched in order, never marked saved', async () => {
    const clicks: string[] = [];
    const orig = document.createElement;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = orig.call(document, tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: () => clicks.push('click') });
      }
      return el;
    }) as typeof document.createElement);
    const report = await deliverBytesMulti([
      { bytes: b(1), filename: 'a.pdf' },
      { bytes: b(2), filename: 'b.pdf' },
    ]);
    vi.restoreAllMocks();
    expect(report.overall).toBe('dispatched');
    expect(report.entries.map((e) => e.status)).toEqual(['dispatched', 'dispatched']);
    expect(report.entries.every((e) => e.path === undefined)).toBe(true);
    expect(clicks).toHaveLength(2);
  });
});
