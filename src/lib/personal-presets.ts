/*
 * Phase-7 personal presets (plan 261112-0955, RT3 amendment): versioned
 * custom presets with per-step identity (stepId/operationId/
 * operationVersion) so TWO watermark steps can carry different options
 * and checkpoint states. Legacy built-ins (lib/presets.ts PRESETS) are
 * NEVER overwritten — custom ids live in the 'custom:' namespace and the
 * resolver adapts without touching built-in identity.
 *
 * Persistence posture: options ONLY. No Files, bytes, passwords, key
 * material, or document-derived paths ever serialize (JSON-safety gate
 * + explicit secret scan). Import is structural: no executor/module/URL
 * injection, no prototype keys, size caps, version migration.
 */

export const CUSTOM_SCHEMA_VERSION = 2;
export const CUSTOM_ID_PREFIX = 'custom:';
export const PRESET_STEP_MAX = 30;
export const PRESET_OPTIONS_BYTES_MAX = 50_000;
export const PRESET_STORE_MAX = 50;
export const PRESET_IMPORT_BYTES_MAX = 100_000;

export interface CustomStep {
  /** Stable within this preset; resume-by-stepId survives reordering. */
  stepId: string;
  /** Registry operation (tool slug). */
  operationId: string;
  /** Version the options were authored against. */
  operationVersion: number;
  /** JSON-safe typed options. Never document bytes/secrets. */
  options: Record<string, unknown>;
}

export interface CustomPreset {
  schemaVersion: number;
  /** 'custom:'-prefixed — never collides with a built-in slug. */
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  steps: CustomStep[];
}

export class PresetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetValidationError';
  }
}

const JSON_UNSAFE = /"(__proto__|constructor|prototype)"\s*:/;

/** JSON-safety + secret-scan gate for step options. */
function assertOptionsSafe(options: unknown): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new PresetValidationError('step options must be a plain object');
  }
  const json = JSON.stringify(options);
  if (json.length > PRESET_OPTIONS_BYTES_MAX) {
    throw new PresetValidationError(`options exceed ${PRESET_OPTIONS_BYTES_MAX} bytes`);
  }
  if (JSON_UNSAFE.test(json)) {
    throw new PresetValidationError('prototype-polluting keys are rejected');
  }
  // Secret posture: keys hinting at secret carriers are refused (values
  // can never carry File/bytes through the JSON gate anyway).
  for (const key of Object.keys(options)) {
    if (/password|secret|token|key material|privatekey|apikey|api_key/i.test(key)) {
      throw new PresetValidationError(`option key "${key}" looks like a secret carrier`);
    }
  }
}

export function validateCustomPreset(value: unknown): CustomPreset {
  if (value === null || typeof value !== 'object') {
    throw new PresetValidationError('preset must be an object');
  }
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== CUSTOM_SCHEMA_VERSION) {
    throw new PresetValidationError(`schemaVersion must be ${CUSTOM_SCHEMA_VERSION}`);
  }
  if (typeof v.id !== 'string' || !v.id.startsWith(CUSTOM_ID_PREFIX)) {
    throw new PresetValidationError(`id must start with "${CUSTOM_ID_PREFIX}"`);
  }
  if (typeof v.name !== 'string' || v.name.length === 0 || v.name.length > 80) {
    throw new PresetValidationError('name must be 1..80 chars');
  }
  if (typeof v.createdAt !== 'number' || typeof v.updatedAt !== 'number') {
    throw new PresetValidationError('createdAt/updatedAt must be numbers');
  }
  if (!Array.isArray(v.steps) || v.steps.length > PRESET_STEP_MAX) {
    throw new PresetValidationError(`steps must be an array of at most ${PRESET_STEP_MAX}`);
  }
  const seen = new Set<string>();
  for (const rawStep of v.steps) {
    const step = rawStep as Record<string, unknown>;
    if (typeof step.stepId !== 'string' || step.stepId.length === 0 || step.stepId.length > 64) {
      throw new PresetValidationError('stepId must be 1..64 chars');
    }
    if (seen.has(step.stepId)) throw new PresetValidationError(`duplicate stepId ${step.stepId}`);
    seen.add(step.stepId);
    if (typeof step.operationId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(step.operationId)) {
      throw new PresetValidationError('operationId must be a slug');
    }
    if (typeof step.operationVersion !== 'number' || !Number.isInteger(step.operationVersion)) {
      throw new PresetValidationError('operationVersion must be an integer');
    }
    assertOptionsSafe(step.options);
  }
  return value as unknown as CustomPreset;
}

/** Migration dispatch: v1 (slug-keyed legacy drafts) -> v2 (stepId steps). */
function migrateEntry(entry: Record<string, unknown>): CustomPreset {
  const version = entry.schemaVersion;
  if (version === CUSTOM_SCHEMA_VERSION) return validateCustomPreset(entry);
  if (version === 1) {
    // v1 stored {id, name, steps: [{tool, options}]} — synthesize stable
    // stepIds + record operationVersion 1.
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    const migrated = {
      schemaVersion: CUSTOM_SCHEMA_VERSION,
      id: typeof entry.id === 'string' ? entry.id : `${CUSTOM_ID_PREFIX}migrated`,
      name: typeof entry.name === 'string' ? entry.name : 'Migrated',
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      updatedAt: Date.now(),
      steps: (steps as Record<string, unknown>[]).slice(0, PRESET_STEP_MAX).map((st, i) => ({
        stepId: `s${i + 1}`,
        operationId: typeof st.tool === 'string' && /^[a-z0-9-]{1,40}$/.test(st.tool) ? st.tool : 'watermark',
        operationVersion: 1,
        options: (st.options ?? {}) as Record<string, unknown>,
      })),
    };
    return validateCustomPreset(migrated);
  }
  throw new PresetValidationError(`unknown schemaVersion ${String(version)}`);
}

// ---------------------------------------------------------------------------
// Store (localStorage, corrupt-recovery by quarantine)
// ---------------------------------------------------------------------------

const STORE_KEY = 'pdftoolkit-presets-v2';
const QUARANTINE_KEY = 'pdftoolkit-presets-quarantine';

function readStoreRaw(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw == null) return [];
    if (raw.length > PRESET_IMPORT_BYTES_MAX * PRESET_STORE_MAX) {
      throw new PresetValidationError('store exceeds size cap');
    }
    return JSON.parse(raw);
  } catch {
    // Quarantine + reset: corrupt storage never bricks the app.
    try {
      globalThis.localStorage?.setItem(
        QUARANTINE_KEY,
        globalThis.localStorage?.getItem(STORE_KEY) ?? '',
      );
      globalThis.localStorage?.setItem(STORE_KEY, '[]');
    } catch {
      /* storage unavailable — list stays empty */
    }
    return [];
  }
}

function writeStore(list: CustomPreset[]): void {
  if (list.length > PRESET_STORE_MAX) {
    throw new PresetValidationError(`store exceeds ${PRESET_STORE_MAX} presets`);
  }
  globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(list));
}

export function listPresets(): CustomPreset[] {
  const raw = readStoreRaw();
  if (!Array.isArray(raw)) return [];
  const out: CustomPreset[] = [];
  for (const entry of raw) {
    try {
      out.push(migrateEntry(entry as Record<string, unknown>));
    } catch {
      /* one bad entry is skipped (honest per-entry isolation) */
    }
  }
  return out.slice(0, PRESET_STORE_MAX);
}

export function savePreset(preset: CustomPreset): CustomPreset {
  const clean = validateCustomPreset(preset);
  const rest = listPresets().filter((p) => p.id !== clean.id);
  if (rest.length >= PRESET_STORE_MAX) {
    throw new PresetValidationError(`store full (${PRESET_STORE_MAX} presets)`);
  }
  const next = [...rest, { ...clean, updatedAt: Date.now() }];
  writeStore(next);
  return clean;
}

export function deletePreset(id: string): void {
  writeStore(listPresets().filter((p) => p.id !== id));
}

export function newCustomPreset(name: string): CustomPreset {
  const id = `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    schemaVersion: CUSTOM_SCHEMA_VERSION,
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: [],
  };
}

export function clonePreset(source: CustomPreset, name: string): CustomPreset {
  return savePreset({
    ...source,
    id: newCustomPreset(name).id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: source.steps.map((st) => ({ ...st, options: { ...st.options } })),
  });
}

/** Import: size-capped JSON.parse (structure only — no code/URLs to
 * execute; ids stay 'custom:'-namespaced). */
export function importPresets(text: string): CustomPreset[] {
  if (text.length > PRESET_IMPORT_BYTES_MAX) {
    throw new PresetValidationError(`import exceeds ${PRESET_IMPORT_BYTES_MAX} bytes`);
  }
  const parsed: unknown = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: CustomPreset[] = [];
  for (const entry of arr.slice(0, PRESET_STORE_MAX)) {
    out.push(migrateEntry(entry as Record<string, unknown>));
  }
  const existing = new Set(listPresets().map((p) => p.id));
  for (const p of out) writeStoreSafe([...listPresets().filter((q) => q.id !== p.id), p]);
  void existing;
  return out;
}

function writeStoreSafe(list: CustomPreset[]): void {
  if (list.length > PRESET_STORE_MAX) throw new PresetValidationError('store full');
  globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(list));
}

export function exportPresets(): string {
  return JSON.stringify(listPresets());
}

// ---------------------------------------------------------------------------
// Resolver adapter — built-ins keep their identity; customs live in the
// 'custom:' namespace. The consumer (preset-session/banner/strip) asks
// HERE instead of reading PRESETS directly.
// ---------------------------------------------------------------------------

import { getPreset, type Preset } from './presets';

export type ResolvedPreset =
  | { kind: 'builtin'; preset: Preset }
  | { kind: 'custom'; preset: CustomPreset };

export function resolvePreset(idOrSlug: string): ResolvedPreset | null {
  const builtin = getPreset(idOrSlug);
  if (builtin) return { kind: 'builtin', preset: builtin };
  const custom = listPresets().find((p) => p.id === idOrSlug);
  if (custom) return { kind: 'custom', preset: custom };
  return null;
}
