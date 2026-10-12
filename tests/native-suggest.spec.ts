// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NATIVE_SUGGEST_KEY,
  dismissNativeSuggest,
  isNativeSuggestDismissed,
  resetNativeSuggestStore,
  subscribeNativeSuggest,
} from '../src/lib/native-suggest';
import { nativeSuggestEligible } from '../src/hooks/use-native-suggest';
import type { TierResolution } from '../src/lib/capability';

/*
 * Smart-suggestion truth table + dismiss store (v0.6.0 phase 6, R6.5).
 * The D3 trigger rule lives in nativeSuggestEligible (pure); the store is
 * the gpu-choice-pattern observable localStorage store with version-scoped
 * re-arming.
 */

function tier(partial: Partial<TierResolution> & Pick<TierResolution, 'tier' | 'source'>): TierResolution {
  return partial as TierResolution;
}

const STRONG_MEASURED = tier({
  tier: 'gpu-strong',
  source: 'measured',
  benchmark: {
    modelId: 'glm-ocr',
    tokPerSecWarm: 45,
    firstTokenColdMs: 400,
    condition: 'webgpu',
    measuredAt: Date.now(),
    adapterFingerprint: 'fp',
  },
});

const WEAK_MEASURED = tier({
  tier: 'gpu-weak',
  source: 'measured',
  benchmark: {
    modelId: 'glm-ocr',
    tokPerSecWarm: 8,
    firstTokenColdMs: 900,
    condition: 'wasm',
    measuredAt: Date.now(),
    adapterFingerprint: 'fp',
  },
});

beforeEach(() => {
  resetNativeSuggestStore();
});
afterEach(() => {
  resetNativeSuggestStore();
});

describe('nativeSuggestEligible — the D3 trigger rule', () => {
  it('cpu and none tiers are eligible (estimate or measured)', () => {
    expect(nativeSuggestEligible(tier({ tier: 'cpu', source: 'estimate' }))).toBe(true);
    expect(nativeSuggestEligible(tier({ tier: 'none', source: 'estimate' }))).toBe(true);
  });

  it('a measured web record under 12 tok/s is eligible', () => {
    expect(nativeSuggestEligible(WEAK_MEASURED)).toBe(true);
  });

  it('strong or ≥12 tok/s measured records are NOT eligible', () => {
    expect(nativeSuggestEligible(STRONG_MEASURED)).toBe(false);
    expect(
      nativeSuggestEligible(
        tier({
          tier: 'gpu-weak',
          source: 'measured',
          benchmark: { ...WEAK_MEASURED.benchmark!, tokPerSecWarm: 12 },
        }),
      ),
    ).toBe(false);
  });

  it('a NATIVE-condition record NEVER triggers its own suggestion (review F2/F14)', () => {
    expect(
      nativeSuggestEligible(
        tier({
          tier: 'gpu-weak',
          source: 'measured',
          benchmark: { ...WEAK_MEASURED.benchmark!, condition: 'native', tokPerSecWarm: 2 },
        }),
      ),
    ).toBe(false);
  });

  it('estimates (source !== measured) never qualify via tokPerSec', () => {
    expect(nativeSuggestEligible(tier({ tier: 'gpu-weak', source: 'estimate' }))).toBe(false);
  });

  it('null tier is never eligible', () => {
    expect(nativeSuggestEligible(null)).toBe(false);
  });
});

describe('dismiss store — version-scoped re-arm', () => {
  it('starts undismissed; dismissal persists', () => {
    expect(isNativeSuggestDismissed()).toBe(false);
    dismissNativeSuggest();
    expect(isNativeSuggestDismissed()).toBe(true);
    expect(JSON.parse(localStorage.getItem(NATIVE_SUGGEST_KEY)!)).toMatchObject({
      version: __APP_VERSION__,
    });
  });

  it('an OLD-version dismissal does not count (suggestion re-arms per release)', () => {
    localStorage.setItem(
      NATIVE_SUGGEST_KEY,
      JSON.stringify({ at: Date.now(), version: '0.0.1-ancient' }),
    );
    expect(isNativeSuggestDismissed()).toBe(false);
  });

  it('subscribe fires on dismissal; reset returns to the default', () => {
    let events = 0;
    const unsub = subscribeNativeSuggest(() => (events += 1));
    dismissNativeSuggest();
    expect(events).toBe(1);
    resetNativeSuggestStore();
    expect(events).toBe(2);
    expect(isNativeSuggestDismissed()).toBe(false);
    unsub();
  });
});
