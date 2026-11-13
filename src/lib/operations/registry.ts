import type { OperationDescriptor } from './types';

/*
 * Phase-3 operation registry: id-keyed descriptors, registered once at
 * module init by tool adapters. Presets reference descriptor IDs; the
 * registry never holds files or runtime state.
 */

const registry = new Map<string, OperationDescriptor>();

export function registerOperation(desc: OperationDescriptor): void {
  if (!desc.id.includes('.v')) {
    throw new Error(`operation id must be versioned (<tool>.v1): ${desc.id}`);
  }
  if (registry.has(desc.id)) {
    throw new Error(`duplicate operation id: ${desc.id}`);
  }
  registry.set(desc.id, desc);
}

export function getOperation(id: string): OperationDescriptor | undefined {
  return registry.get(id);
}

export function listOperations(): OperationDescriptor[] {
  return [...registry.values()];
}

/** Test-only reset — production modules never unregister. */
export function resetOperationsForTests(): void {
  registry.clear();
}
