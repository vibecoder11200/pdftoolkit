/*
 * Preset session store (v0.8.1 phase 4): WHICH chain is running and WHICH
 * step the user is on — nothing else. Same singleton pattern as handoff.ts.
 * NO bytes/File storage here: the chained file rides the existing handoff
 * (appendPendingFiles), and each host tool's existing done-state retention
 * (useLastOutput / outBytes) feeds the banner's continue button.
 */
import { getPreset, type Preset, type PresetStepDefaults } from './presets';

export interface PresetSession {
  presetSlug: string;
  /** 0-based index into preset.steps — the step the user is currently ON. */
  stepIndex: number;
}

type SessionListener = (session: PresetSession | null) => void;

let session: PresetSession | null = null;
const listeners = new Set<SessionListener>();

function notify(): void {
  for (const listener of listeners) listener(session);
}

/** Begin a chain at step 0. Unknown slugs are ignored (data-driven guard). */
export function startPresetSession(presetSlug: string): void {
  if (!getPreset(presetSlug)) return;
  session = { presetSlug, stepIndex: 0 };
  notify();
}

/** Move the walker; clamped to the preset's step range. No-op without a session. */
export function setPresetStep(stepIndex: number): void {
  if (!session) return;
  const preset = getPreset(session.presetSlug);
  if (!preset) return;
  const clamped = Math.max(0, Math.min(preset.steps.length - 1, stepIndex));
  session = { presetSlug: preset.slug, stepIndex: clamped };
  notify();
}

/**
 * End the chain WITHOUT touching parked files (the banner's X): a parked
 * batch stays consumable by whatever tool takes it next.
 */
export function clearPresetSession(): void {
  if (!session) return;
  session = null;
  notify();
}

export function getPresetSession(): PresetSession | null {
  return session;
}

/**
 * Reactive subscription (handoff.ts pattern): fires on start/step/clear AND
 * replays the current session to new subscribers — the banner mounts with
 * the session already active (parking happens before navigation).
 */
export function onPresetSession(fn: SessionListener): () => void {
  listeners.add(fn);
  fn(session);
  return () => listeners.delete(fn);
}

/**
 * The tool's prefill slice, ONLY when the active session is standing on this
 * tool's step right now. Called from a useState initializer (exactly once
 * per mount); tools not targeted by a session get undefined and stay
 * untouched. Slugs with no defaults slice (e.g. merge) always get undefined.
 */
export function presetDefaultsFor<K extends keyof PresetStepDefaults>(
  toolSlug: K,
): PresetStepDefaults[K] | undefined;
export function presetDefaultsFor(toolSlug: string): undefined;
export function presetDefaultsFor(toolSlug: string): unknown {
  if (!session) return undefined;
  const preset: Preset | undefined = getPreset(session.presetSlug);
  if (!preset || preset.steps[session.stepIndex] !== toolSlug) return undefined;
  return preset.defaults[toolSlug as keyof PresetStepDefaults];
}

// token-mapped
