/*
 * Phase-3 runtime artifact ownership (RT amendment): raw-byte leases,
 * decoded-document leases, previews and export outputs all acquire a lease
 * here. ACTIVE leases cannot be evicted; idle (released-eligible) leases
 * are evicted FIFO under budget pressure. A paused run reaching budget
 * requests release/regeneration/reselection through the pressure result
 * rather than retaining unlimited buffers. Persistent config never
 * contains artifacts (preset purity is asserted by tests/api-purity.spec).
 */

export type ArtifactKind = 'raw-bytes' | 'decoded-doc' | 'preview' | 'export';

export interface ArtifactLease {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly owner: string;
  readonly bytes: number;
  /** Active leases back a live run/preview and cannot be evicted. */
  active: boolean;
  release(): void;
}

export interface ArtifactPressure {
  totalBytes: number;
  idleBytes: number;
  /** True when total exceeds the budget even with every idle lease evicted. */
  overBudgetWithEviction: boolean;
}

export const ARTIFACT_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

let leaseCounter = 0;

class ArtifactRegistry {
  private leases = new Map<string, ArtifactLease>();

  acquire(owner: string, kind: ArtifactKind, opts: { bytes?: number; active?: boolean } = {}): ArtifactLease {
    leaseCounter += 1;
    const id = `lease-${leaseCounter}`;
    const lease: ArtifactLease = {
      id,
      kind,
      owner,
      bytes: opts.bytes ?? 0,
      active: opts.active ?? true,
      release: () => {
        this.leases.delete(id);
      },
    };
    this.leases.set(id, lease);
    return lease;
  }

  totalBytes(): number {
    let n = 0;
    for (const l of this.leases.values()) n += l.bytes;
    return n;
  }

  idleBytes(): number {
    let n = 0;
    for (const l of this.leases.values()) if (!l.active) n += l.bytes;
    return n;
  }

  /** Evict idle leases (oldest first) until at least `bytesNeeded` is free
   * or nothing idle remains. Returns the bytes actually freed. */
  evictIdle(bytesNeeded: number): number {
    let freed = 0;
    const idle = [...this.leases.values()].filter((l) => !l.active);
    for (const lease of idle) {
      if (freed >= bytesNeeded) break;
      lease.release();
      freed += lease.bytes;
    }
    return freed;
  }

  pressure(budget: number = ARTIFACT_BUDGET_BYTES): ArtifactPressure {
    const totalBytes = this.totalBytes();
    const idleBytes = this.idleBytes();
    return {
      totalBytes,
      idleBytes,
      overBudgetWithEviction: totalBytes - idleBytes > budget,
    };
  }
}

export const artifactRegistry = new ArtifactRegistry();
