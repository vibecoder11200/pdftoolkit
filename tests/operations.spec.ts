import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOperation,
  listOperations,
  registerOperation,
  resetOperationsForTests,
} from '../src/lib/operations/registry';
import { startOperation } from '../src/lib/operations/runner';
import { beginJob, endJob, hasActiveJob } from '../src/lib/jobs';
import type { OperationDescriptor } from '../src/lib/operations/types';

function makeDesc(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    id: 'demo.v1',
    version: 1,
    label: 'demo',
    inputMime: ['application/pdf'],
    inputCardinality: 1,
    outputMime: 'application/pdf',
    outputCardinality: 1,
    requires: {},
    budget: {},
    defaultOptions: () => ({}),
    run: vi.fn(async () => 'out'),
    ...overrides,
  };
}

const file = (size = 10) => new File([new Uint8Array(size)], 'f.pdf', { type: 'application/pdf' });

beforeEach(() => {
  resetOperationsForTests();
});
afterEach(() => {
  expect(hasActiveJob()).toBe(false);
});

describe('operation registry', () => {
  it('registers, gets and lists versioned descriptors; refuses dupes and unversioned ids', () => {
    const desc = makeDesc();
    registerOperation(desc);
    expect(getOperation('demo.v1')).toBe(desc);
    expect(listOperations()).toHaveLength(1);
    expect(() => registerOperation(desc)).toThrow('duplicate');
    expect(() =>
      registerOperation({ ...makeDesc({ id: 'no-version' }) }),
    ).toThrow('versioned');
  });
});

describe('operation runner', () => {
  it('brackets the run with beginJob/endJob in finally (release after failure)', async () => {
    const desc = makeDesc({
      run: vi.fn(async () => {
        expect(hasActiveJob()).toBe(true); // visible to shared-resource watchers
        throw new Error('boom');
      }),
    });
    const { result } = startOperation(desc, [file()], {});
    const r = await result;
    expect(r).toMatchObject({ status: 'failed', error: 'boom' });
    expect(hasActiveJob()).toBe(false);
  });

  it('execution success is returned raw; delivery is the caller’s job', async () => {
    const { result } = startOperation(makeDesc(), [file()], {});
    const r = await result;
    expect(r.status).toBe('complete');
    expect(r.output).toBe('out');
  });

  it('budget gate refuses oversized inputs before any work', async () => {
    const run = vi.fn(async () => 'never');
    const { result } = startOperation(
      makeDesc({ budget: { maxInputBytes: 5 }, run }),
      [file(100)],
      {},
    );
    const r = await result;
    expect(r.status).toBe('failed');
    expect(r.error).toContain('budget');
    expect(run).not.toHaveBeenCalled();
  });

  it('unacknowledged confirmations refuse with the missing key', async () => {
    const run = vi.fn(async () => 'x');
    const { result } = startOperation(
      makeDesc({ requires: { confirmations: ['scan-routing'] }, run }),
      [file()],
      {},
    );
    const r = await result;
    expect(r.status).toBe('failed');
    expect(r.error).toContain('scan-routing');
    expect(run).not.toHaveBeenCalled();
  });

  it('cooperative cancel between stages: status cancelled, no output', async () => {
    const gateCtl: { resolve: () => void } = { resolve: () => {} };
    const gate = new Promise<void>((res) => {
      gateCtl.resolve = res;
    });
    const desc = makeDesc({
      run: vi.fn(async (_f, _o, ctx) => {
        await gate; // stage boundary
        if (ctx.signal.aborted) throw new Error('aborted-by-user');
        return 'out';
      }),
    });
    const handle = startOperation(desc, [file()], {});
    const resPromise = handle.result;
    handle.cancel();
    gateCtl.resolve();
    const r = await resPromise;
    expect(r.status).toBe('cancelled');
  });

  it('no auto replay after crash: one run attempt only', async () => {
    const run = vi.fn(async () => {
      throw new Error('crash');
    });
    const { result } = startOperation(makeDesc({ run }), [file()], {});
    await result;
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('jobs registry (shared lifecycle)', () => {
  it('begin/end pairs nest and release after failure paths', () => {
    beginJob('a');
    beginJob('b');
    expect(hasActiveJob()).toBe(true);
    endJob('a');
    expect(hasActiveJob()).toBe(true);
    endJob('b');
    expect(hasActiveJob()).toBe(false);
    // end of an unknown id is a no-op (never releases someone else's job)
    endJob('ghost');
    expect(hasActiveJob()).toBe(false);
  });
});
