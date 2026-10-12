import { useEffect, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { aiTierEstimate } from '../lib/ai-run';
import { getNativeStatus } from '../lib/ai-native-client';
import {
  isNativeSuggestDismissed,
  subscribeNativeSuggest,
} from '../lib/native-suggest';
import { isTauri } from '../lib/platform';

/*
 * Smart-suggestion visibility (v0.6.0 phase 5, R5.1 + plan Risk 1).
 *
 * Trigger (user-locked D3): tier = cpu/none OR a MEASURED web record under
 * 12 tok/s. The benchmark record is FILTERED by condition before use
 * (review F2 — a native record never poses as the web tier; review F14 — a
 * cpu-backend native record never triggers its own suggestion), and the
 * card never shows once the native engine is already installed.
 *
 * Visibility splits into a sync-eligible part (tier/dismiss from loaded
 * stores) and an ASYNC refinement (engine presence from native_engine_status,
 * non-activity read R4.6): the card mounts HIDDEN and reveals — it must
 * never flash ON then OFF (the wrong direction is a UI lie).
 */
export function useNativeSuggestVisible(): boolean {
  const dismissed = useSyncExternalStore(subscribeNativeSuggest, isNativeSuggestDismissed);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Web NEVER sees the card (contract acceptance 4) — double gate with
    // the component-level isTauri().
    if (!isTauri() || dismissed) {
      setVisible(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      let eligible = false;
      try {
        const tier = await aiTierEstimate();
        const rec = tier.benchmark;
        const webMeasuredSlow =
          tier.source === 'measured' &&
          rec !== undefined &&
          rec.condition !== 'native' &&
          rec.tokPerSecWarm < 12;
        eligible = tier.tier === 'cpu' || tier.tier === 'none' || webMeasuredSlow;
      } catch {
        eligible = false;
      }
      if (!eligible) {
        if (!cancelled) setVisible(false);
        return;
      }
      // Never suggest an engine that is already installed.
      const st = await getNativeStatus();
      const installed = !!st && st.enginePresent && st.modelPresent;
      if (!cancelled) setVisible(eligible && !installed);
    })();
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  return visible;
}
