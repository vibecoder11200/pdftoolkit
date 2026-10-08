import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adapterFingerprint,
  createBenchmarkStore,
  detectHardware,
  getHardwareInfo,
  resolveTier,
  runBenchmark,
  type BenchmarkRecord,
  type HardwareInfo,
  type TierResolution,
} from '../../lib/capability';
import { AI_MODEL_ID, isModelCachedLocally } from '../../lib/ai-models';
import { sharedAiClient } from '../../lib/ai-worker-client';
import { beginJob, endJob } from '../../lib/jobs';

/** e2e mock seam (F8) — same page-URL flag the OCR tool reads. */
const isAiMock = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ai-mock');

interface HardwareState {
  hardware: HardwareInfo;
  resolution: TierResolution;
}

/**
 * Re-measure: load the engine (cache-hit when the OCR tool already ran),
 * then the F17 protocol — one discarded warmup, one measured pass — on a
 * synthetic blank page. The record lands in the same store the OCR tool
 * reads, so the tier chip updates everywhere on the next estimate.
 */
async function rebenchmark(): Promise<HardwareState> {
  const client = sharedAiClient({ mock: isAiMock() });
  const { device } = await client.ensureLoaded(AI_MODEL_ID, () => undefined);
  const hardware = await detectHardware();
  const fingerprint = adapterFingerprint(hardware.adapter);
  const executor = {
    async generate(
      image: { width: number; height: number },
      maxNewTokens: number,
    ): Promise<{ genTokens: number; ms: number; firstTokenMs: number | null }> {
      const started = performance.now();
      let firstTokenMs: number | null = null;
      const result = await client.ocrPage(
        {
          data: new Uint8ClampedArray(image.width * image.height * 4).fill(255),
          width: image.width,
          height: image.height,
        },
        () => {
          if (firstTokenMs === null) firstTokenMs = performance.now() - started;
        },
        { maxNewTokens },
      );
      return { genTokens: result.genTokens, ms: result.ms, firstTokenMs };
    },
  };
  const record = await runBenchmark(
    AI_MODEL_ID,
    device === 'wasm' ? 'wasm' : 'webgpu',
    fingerprint,
    executor,
    createBenchmarkStore(),
  );
  return { hardware, resolution: resolveTier(hardware, record) };
}

function AdapterLine({ hardware }: { hardware: HardwareInfo }) {
  const { t } = useTranslation();
  const a = hardware.adapter;
  if (!a) return <p className="text-xs text-text-muted">{t('settings.hw_no_adapter')}</p>;
  const label = [a.vendor, a.architecture, a.device].filter(Boolean).join(' · ');
  return (
    <p className="text-xs text-text-muted" data-testid="settings-adapter">
      {label || t('settings.hw_no_adapter')}
    </p>
  );
}

export function HardwarePanel() {
  const { t } = useTranslation();
  const [state, setState] = useState<HardwareState | null>(null);
  const [modelCached, setModelCached] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hardware, perModel } = await getHardwareInfo();
      const cached = await isModelCachedLocally();
      if (!cancelled) {
        setState({
          hardware,
          // No stored benchmark → perModel has no entry → estimate-only.
          resolution: perModel[AI_MODEL_ID] ?? resolveTier(hardware, undefined),
        });
        setModelCached(cached);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const measure = useCallback(async () => {
    if (measuring) return;
    setMeasuring(true);
    setError(null);
    beginJob('ai-bench');
    try {
      setState(await rebenchmark());
      setModelCached(await isModelCachedLocally());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      endJob('ai-bench');
      setMeasuring(false);
    }
  }, [measuring]);

  const rec: BenchmarkRecord | undefined = state?.resolution.benchmark;
  // resolveTier flags staleness itself (a fresh measured record cannot be
  // stale by construction — the fingerprint matched to get there).
  const stale = state?.resolution.stale ?? false;

  return (
    <section aria-labelledby="settings-hardware" className="mt-10">
      <h2 id="settings-hardware" className="text-lg font-bold">
        {t('settings.hw_title')}
      </h2>
      {state ? (
        <div className="mt-3 rounded-xl border border-border-strong px-4 py-3" data-testid="settings-hardware">
          <AdapterLine hardware={state.hardware} />
          <p className="mt-1.5 text-sm">
            <span className="font-semibold">{t('settings.hw_tier_label')}:</span>{' '}
            {t(`settings.tier_${state.resolution.tier}`)}
            <span className="ml-2 rounded bg-surface-hover px-1.5 py-0.5 text-xs font-normal">
              {state.resolution.source === 'measured'
                ? t('ocr.tier_measured')
                : t('ocr.tier_estimate')}
            </span>
          </p>
          {rec ? (
            <p className="mt-1 text-xs text-text-muted" data-testid="settings-bench">
              {t('settings.hw_bench_line', {
                tokens: rec.tokPerSecWarm,
                condition: rec.condition,
                date: new Date(rec.measuredAt).toLocaleString(),
              })}
            </p>
          ) : (
            <p className="mt-1 text-xs text-text-muted">{t('settings.hw_no_bench')}</p>
          )}
          {stale ? (
            <p className="mt-1 text-xs text-amber-600" data-testid="settings-bench-stale">
              {t('settings.hw_stale')}
            </p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="settings-remeasure"
              disabled={!modelCached || measuring}
              onClick={() => void measure()}
              className="min-h-9 rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            >
              {measuring ? t('settings.hw_measuring') : t('settings.hw_remeasure')}
            </button>
            {!modelCached ? (
              <span className="text-xs text-text-muted">{t('settings.hw_remeasure_needs_model')}</span>
            ) : null}
            {error ? (
              <span className="text-xs text-red-500" data-testid="settings-remeasure-error">
                {t('settings.hw_measure_error', { message: error })}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-text-muted">{t('settings.hw_loading')}</p>
      )}
    </section>
  );
}
