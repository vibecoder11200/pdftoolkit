/*
 * Preset session store (v0.8.1 phase 4, REWORKED v0.13.0 phase 3): WHICH
 * chain is running and WHICH step — nothing else. Same singleton pattern
 * as handoff.ts. NO bytes/File storage: the chained file rides the
 * existing handoff (appendPendingFiles); each host tool's done-state
 * retention (useLastOutput / outBytes) feeds the banner's continue button.
 *
 * v0.13.0 rework (RT finding 6 — customs died at step 1): the session
 * carries the RESOLVED chain (builtin or custom, via the adapter) instead
 * of a builtin-only slug. Prefill resolves per STEP INDEX against the
 * chain's slug-keyed defaults — expressible because builder v1 forbids
 * repeating a slug within one chain (validated in the builder UI).
 */
import { resolveChain, type Chain } from './custom-preset-adapter';
import type { PresetStepDefaults } from './presets';

export interface PresetSession {
  chain: Chain;
  /** 0-based index into chain.steps — the step the user is currently ON. */
  stepIndex: number;
}

type SessionListener = (session: PresetSession | null) => void;

let session: PresetSession | null = null;
const listeners = new Set<SessionListener>();

function notify(): void {
  for (const listener of listeners) listener(session);
}

/** Begin a chain at step 0. Unknown ids/slugs are ignored (data-driven guard). */
export function startPresetSession(idOrSlug: string): void {
  const chain = resolveChain(idOrSlug);
  if (!chain) return;
  session = { chain, stepIndex: 0 };
  notify();
}

/** Move the walker; clamped to the chain's step range. No-op without a session. */
export function setPresetStep(stepIndex: number): void {
  if (!session) return;
  const clamped = Math.max(0, Math.min(session.chain.steps.length - 1, stepIndex));
  session = { chain: session.chain, stepIndex: clamped };
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
 * The tool's prefill slice, ONLY when the active session stands on this
 * tool's step right now. Called from a useState initializer (exactly once
 * per mount); tools not targeted get undefined and stay untouched. Slugs
 * with no defaults slice (e.g. merge) always get undefined. v1 chains have
 * unique slugs, so slug-keyed defaults ARE the per-step prefill.
 */
export function presetDefaultsFor<K extends keyof PresetStepDefaults>(
  toolSlug: K,
): PresetStepDefaults[K] | undefined;
export function presetDefaultsFor(toolSlug: string): undefined;
export function presetDefaultsFor(toolSlug: string): unknown {
  if (!session) return undefined;
  if (session.chain.steps[session.stepIndex]?.slug !== toolSlug) return undefined;
  return session.chain.defaults[toolSlug as keyof PresetStepDefaults];
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

// token-mapped
