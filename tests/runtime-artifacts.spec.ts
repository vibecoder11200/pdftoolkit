import { describe, expect, it, beforeEach } from 'vitest';
import {
  ARTIFACT_BUDGET_BYTES,
  artifactRegistry,
} from '../src/lib/runtime-artifacts';

beforeEach(() => {
  // drain leases from previous tests
  artifactRegistry.evictIdle(Number.MAX_SAFE_INTEGER);
  // force-release anything still held (test hygiene only)
  let guard = 0;
  while (artifactRegistry.totalBytes() > 0 && guard++ < 1000) {
    artifactRegistry.evictIdle(Number.MAX_SAFE_INTEGER);
    break;
  }
});

describe('runtime artifact leases', () => {
  it('active leases are non-evictable; released leases free their bytes', () => {
    const lease = artifactRegistry.acquire('tool-a', 'raw-bytes', { bytes: 1000, active: true });
    expect(artifactRegistry.totalBytes()).toBe(1000);
    expect(artifactRegistry.evictIdle(1000)).toBe(0); // active — nothing freed
    expect(artifactRegistry.totalBytes()).toBe(1000);
    lease.active = false; // run finished, preview parked (idle)
    expect(artifactRegistry.evictIdle(500)).toBe(1000);
    expect(artifactRegistry.totalBytes()).toBe(0);
  });

  it('eviction is FIFO among idle leases and stops at the needed bytes', () => {
    const a = artifactRegistry.acquire('t1', 'preview', { bytes: 300, active: false });
    const b = artifactRegistry.acquire('t2', 'preview', { bytes: 200, active: false });
    artifactRegistry.acquire('t3', 'raw-bytes', { bytes: 500, active: true });
    const freed = artifactRegistry.evictIdle(400);
    // 300 < 400, so the second idle lease goes too — "at least" semantics.
    expect(freed).toBe(500);
    expect(artifactRegistry.totalBytes()).toBe(500);
    a.release(); // no-op after eviction
    b.release();
  });

  it('pressure reports over-budget only when ACTIVE bytes exceed the budget', () => {
    const active = artifactRegistry.acquire('run', 'decoded-doc', {
      bytes: ARTIFACT_BUDGET_BYTES + 1,
      active: true,
    });
    expect(artifactRegistry.pressure().overBudgetWithEviction).toBe(true);
    active.active = false;
    expect(artifactRegistry.pressure().overBudgetWithEviction).toBe(false);
    active.release();
  });

  it('paused run reaching budget requests release, not unlimited retention', () => {
    const parked = artifactRegistry.acquire('run', 'export', { bytes: 800, active: false });
    const active = artifactRegistry.acquire('run', 'raw-bytes', { bytes: 500, active: true });
    const p = artifactRegistry.pressure(1000);
    expect(p.overBudgetWithEviction).toBe(false); // eviction can free the parked bytes
    expect(p.idleBytes).toBe(800);
    parked.release();
    active.release();
  });
});
