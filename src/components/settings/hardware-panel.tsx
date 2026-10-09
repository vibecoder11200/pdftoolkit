import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adapterFingerprint,
  createBenchmarkStore,
  detectHardware,
  getHardwareInfo,
  runBenchmark,
  type BenchmarkRecord,
  type HardwareInfo,
  type TierResolution,
} from '../../lib/capability';
import {
  adapterDisplayLabel,
  adapterPowerClass,
  probeAdapters,
  resolveChoice,
  setGpuChoice,
  type AdapterDiscovery,
  type DiscoveredAdapter,
  type GpuChoice,
  type PowerPreference,
  gpuChoiceEquals,
} from '../../lib/gpu-choice';
import { useGpuChoice } from '../../hooks/use-gpu-choice';
import { AI_MODEL_ID, isModelCachedLocally } from '../../lib/ai-models';
import { EngineBusyError, sharedAiClient } from '../../lib/ai-worker-client';
import { getGpuForce, restartWithGpuForce, setGpuForce } from '../../lib/desktop-gpu-force';
import { isTauri } from '../../lib/platform';
import { beginJob, endJob } from '../../lib/jobs';
import { useActiveJob } from '../../hooks/use-active-job';

/** e2e mock seam (F8) — same page-URL flag the OCR tool reads. */
const isAiMock = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ai-mock');

interface HardwareState {
  hardware: HardwareInfo;
  /** v2: per-adapter records for the AI model — one measured row per
   *  fingerprint instead of a single overwriting record. */
  perAdapter: Record<string, TierResolution>;
}

/**
 * Re-measure on a SPECIFIC adapter (phase 4, "Đo trên card này"): the F17
 * protocol driven through an applyGpuChoice OVERRIDE — RED-TEAM H6: the
 * PERSISTED choice is never temp-written, so a failed measurement on a
 * flaky card cannot strand the user's selection. After the measurement the
 * persisted choice is re-applied (the engine re-loads lazily on next use).
 * The record keys on the ENGINE-reported fingerprint (H4/A7); a divergence
 * from the discovery-time fingerprint surfaces as a mismatch note instead
 * of silently mis-keying.
 */
async function measureOnAdapter(
  target: { fingerprint: string; powerPreference?: PowerPreference },
): Promise<{
  state: HardwareState;
  engineFingerprint: string | null;
}> {
  const client = sharedAiClient({ mock: isAiMock() });
  await client.applyGpuChoice({ kind: 'gpu', ...target });
  beginJob('ai-bench');
  try {
    const load = await client.ensureLoaded(AI_MODEL_ID, () => undefined);
    const hardware = await detectHardware();
    const fingerprint = load.adapterFingerprint ?? adapterFingerprint(hardware.adapter);
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
      load.device === 'wasm' ? 'wasm' : 'webgpu',
      fingerprint,
      executor,
      createBenchmarkStore(),
    );
    const { hardware: fresh, perModel } = await getHardwareInfo();
    return {
      state: {
        hardware: fresh,
        perAdapter: perModel[AI_MODEL_ID] ?? {},
      },
      engineFingerprint: record.adapterFingerprint,
    };
  } finally {
    endJob('ai-bench');
    // Restore the persisted choice — the engine re-loads lazily on next use.
    await client.applyGpuChoice().catch(() => undefined);
  }
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

/** Plain driver strings only (SEC-3) — no dangerouslySetInnerHTML anywhere. */
function AdapterRow({
  adapter,
  discovery,
  selected,
  onSelect,
  record,
  canMeasure,
  measuring,
  onMeasure,
}: {
  adapter: DiscoveredAdapter;
  discovery: AdapterDiscovery;
  selected: GpuChoice;
  onSelect: (choice: GpuChoice) => void;
  record?: BenchmarkRecord;
  canMeasure: boolean;
  measuring: boolean;
  onMeasure: (adapter: DiscoveredAdapter) => void;
}) {
  const { t } = useTranslation();
  const software = adapter.isFallbackAdapter === true;
  const powerClass = adapterPowerClass(discovery, adapter.fingerprint);
  const isSelected =
    selected !== 'auto' && selected.kind === 'adapter'
      ? selected.fingerprint === adapter.fingerprint
      : false;
  return (
    <li className={`grid gap-1 rounded-lg border px-3 py-2 text-sm ${software ? 'border-border-strong opacity-60' : 'border-border-strong'}`}>
      <label className="flex min-h-6 items-center gap-2 font-semibold">
        <input
          type="radio"
          name="gpu-choice"
          data-testid={`gpu-choice-${adapter.fingerprint}`}
          disabled={software}
          checked={isSelected}
          onChange={() => onSelect({ kind: 'adapter', fingerprint: adapter.fingerprint })}
        />
        <span data-testid="gpu-adapter-label">{adapterDisplayLabel(adapter)}</span>
        {software && (
          <span className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-normal">
            {t('settings.gpu_adapter_software')}
          </span>
        )}
        {!software && powerClass === 'maybe-discrete' && (
          <span className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-normal">
            {t('settings.gpu_class_discrete')}
          </span>
        )}
        {!software && powerClass === 'likely-integrated' && (
          <span className="rounded bg-surface-hover px-1.5 py-0.5 text-xs font-normal">
            {t('settings.gpu_class_integrated')}
          </span>
        )}
      </label>
      <div className="flex flex-wrap items-center gap-2 pl-6 text-xs text-text-muted">
        {record ? (
          <span data-testid={`gpu-bench-${adapter.fingerprint}`}>
            {t('settings.gpu_bench_line', {
              tokens: record.tokPerSecWarm,
              condition: record.condition,
              date: new Date(record.measuredAt).toLocaleString(),
            })}
          </span>
        ) : (
          <span data-testid={`gpu-bench-${adapter.fingerprint}`}>{t('settings.gpu_no_bench')}</span>
        )}
        <button
          type="button"
          data-testid={`gpu-measure-${adapter.fingerprint}`}
          disabled={!canMeasure || measuring || software}
          onClick={() => onMeasure(adapter)}
          className="min-h-8 rounded border border-border-strong px-2 py-0.5 hover:bg-surface-hover disabled:opacity-50"
        >
          {measuring ? t('settings.hw_measuring') : t('settings.gpu_measure_here')}
        </button>
      </div>
    </li>
  );
}

export function HardwarePanel() {
  const { t } = useTranslation();
  const [state, setState] = useState<HardwareState | null>(null);
  const [discovery, setDiscovery] = useState<AdapterDiscovery | null>(null);
  const [modelCached, setModelCached] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [measureMismatch, setMeasureMismatch] = useState<string | null>(null);
  const storedChoice = useGpuChoice();
  const [draftChoice, setDraftChoice] = useState<GpuChoice>(storedChoice);
  const jobActive = useActiveJob();
  const [forceFlag, setForceFlag] = useState<boolean | null>(null);
  const [forceBusy, setForceBusy] = useState(false);

  // Draft follows the store until the user edits (apply owns the commit).
  useEffect(() => {
    setDraftChoice(storedChoice);
  }, [storedChoice]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hardware, perModel } = await getHardwareInfo();
      const probes = await probeAdapters();
      const cached = await isModelCachedLocally();
      if (!cancelled) {
        setState({
          hardware,
          perAdapter: perModel[AI_MODEL_ID] ?? {},
        });
        setDiscovery(probes);
        setModelCached(cached);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void getGpuForce().then((flag) => setForceFlag(flag));
  }, []);

  // RED-TEAM F7/A5 recovery: force flag ON but EVERY probe null — the
  // dGPU is absent/blocklisted and AI is disabled app-wide. One-click revert.
  const forceRecoveryRow =
    forceFlag === true && discovery !== null && discovery.adapters.length === 0;

  // Validation decision (2026-10-09): smart SUGGESTION, never auto-enable —
  // both probes collapsing to ONE non-software adapter is the signature of
  // Windows handing every request the same card.
  const collapsedSingle =
    discovery !== null &&
    discovery.adapters.length === 1 &&
    discovery.adapters[0].isFallbackAdapter !== true;

  const apply = useCallback(async () => {
    if (applying || jobActive) return;
    setApplying(true);
    setError(null);
    try {
      // The client resolves its load request from the PERSISTED store, so
      // the new choice must be written first — but a failed apply rolls the
      // store back: it must never claim a device the engine is not using
      // (review P2 — the status line would otherwise lie until the next
      // idle dispose).
      setGpuChoice(draftChoice);
      const client = sharedAiClient({ mock: isAiMock() });
      await client.applyGpuChoice();
    } catch (err) {
      setGpuChoice(storedChoice);
      if (err instanceof EngineBusyError) {
        setError(t('settings.gpu_busy_error'));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setApplying(false);
    }
  }, [applying, draftChoice, storedChoice, jobActive, t]);

  const measure = useCallback(
    async (adapter: DiscoveredAdapter) => {
      if (measuring) return;
      setMeasuring(true);
      setError(null);
      setMeasureMismatch(null);
      try {
        const discoveryNow = discovery ?? (await probeAdapters());
        const { resolved } = resolveChoice(
          { kind: 'adapter', fingerprint: adapter.fingerprint },
          discoveryNow,
        );
        const target =
          resolved.kind === 'gpu'
            ? { fingerprint: resolved.fingerprint, powerPreference: resolved.powerPreference }
            : { fingerprint: adapter.fingerprint };
        const result = await measureOnAdapter(target);
        setState(result.state);
        setModelCached(await isModelCachedLocally());
        if (
          result.engineFingerprint &&
          result.engineFingerprint !== adapter.fingerprint
        ) {
          setMeasureMismatch(
            t('settings.gpu_measure_mismatch', {
              expected: adapter.fingerprint,
              actual: result.engineFingerprint,
            }),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setMeasuring(false);
      }
    },
    [discovery, measuring, t],
  );

  const toggleForce = useCallback(
    async (next: boolean) => {
      if (forceBusy) return;
      setForceBusy(true);
      setError(null);
      try {
        await setGpuForce(next);
        await restartWithGpuForce(next); // detached-spawn restart (A4)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setForceBusy(false);
      }
    },
    [forceBusy],
  );

  const resolution: TierResolution | undefined =
    state && state.hardware.adapter
      ? state.perAdapter[adapterFingerprint(state.hardware.adapter)]
      : undefined;
  const rec: BenchmarkRecord | undefined = resolution?.benchmark;
  // resolveTier flags staleness itself (a fresh measured record cannot be
  // stale by construction — the fingerprint matched to get there).
  const stale = resolution?.stale ?? false;
  const storedAdapterChoice =
    storedChoice !== 'auto' && storedChoice.kind === 'adapter' ? storedChoice : null;
  const storedWarning =
    storedAdapterChoice && discovery ? resolveChoice(storedAdapterChoice, discovery).warning : null;
  // The missing-adapter notice interpolates WHICH fingerprint went away.
  const staleFingerprint = storedAdapterChoice?.fingerprint ?? '';

  return (
    <section aria-labelledby="settings-hardware" className="mt-10">
      <h2 id="settings-hardware" className="text-lg font-bold">
        {t('settings.hw_title')}
      </h2>
      {state ? (
        <div className="mt-3 grid gap-3 rounded-xl border border-border-strong px-4 py-3" data-testid="settings-hardware">
          <AdapterLine hardware={state.hardware} />
          {resolution ? (
            <p className="text-sm">
              <span className="font-semibold">{t('settings.hw_tier_label')}:</span>{' '}
              {t(`settings.tier_${resolution.tier}`)}
              <span className="ml-2 rounded bg-surface-hover px-1.5 py-0.5 text-xs font-normal">
                {resolution.source === 'measured'
                  ? t('ocr.tier_measured')
                  : t('ocr.tier_estimate')}
              </span>
            </p>
          ) : (
            <p className="text-sm">
              <span className="font-semibold">{t('settings.hw_tier_label')}:</span>{' '}
              {t(`settings.tier_${state.hardware.tier}`)}
              <span className="ml-2 rounded bg-surface-hover px-1.5 py-0.5 text-xs font-normal">
                {t('ocr.tier_estimate')}
              </span>
            </p>
          )}

          {/* ---------------------- adapter list + choice ---------------------- */}
          {discovery && discovery.adapters.length > 0 && (
            <fieldset className="grid gap-2" data-testid="gpu-adapter-list">
              <legend className="text-sm font-bold">{t('settings.gpu_pick_title')}</legend>
              {storedWarning === 'missing-adapter' && (
                <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400" role="status">
                  {t('settings.gpu_missing', { label: staleFingerprint })}
                </p>
              )}
              <ul className="grid gap-2">
                {discovery.adapters.map((adapter) => (
                  <AdapterRow
                    key={adapter.fingerprint}
                    adapter={adapter}
                    discovery={discovery}
                    selected={draftChoice}
                    onSelect={setDraftChoice}
                    record={state.perAdapter[adapter.fingerprint]?.benchmark}
                    canMeasure={modelCached && !jobActive}
                    measuring={measuring}
                    onMeasure={(a) => void measure(a)}
                  />
                ))}
              </ul>
              <label className="flex min-h-6 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="gpu-choice"
                  data-testid="gpu-choice-auto"
                  checked={draftChoice === 'auto'}
                  onChange={() => setDraftChoice('auto')}
                />
                {t('settings.gpu_auto')}
              </label>
              <label className="flex min-h-6 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="gpu-choice"
                  data-testid="gpu-choice-cpu"
                  checked={draftChoice !== 'auto' && draftChoice.kind === 'cpu'}
                  onChange={() => setDraftChoice({ kind: 'cpu' })}
                />
                {t('settings.gpu_cpu')}
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="gpu-apply"
                  disabled={applying || jobActive || gpuChoiceEquals(draftChoice, storedChoice)}
                  onClick={() => void apply()}
                  className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent disabled:opacity-50"
                >
                  {applying ? t('settings.gpu_applying') : t('settings.gpu_apply')}
                </button>
                <span className="text-xs text-text-muted">{t('settings.gpu_apply_hint')}</span>
                {error ? (
                  <span className="text-xs text-red-500" data-testid="gpu-apply-error">
                    {error}
                  </span>
                ) : null}
                {measureMismatch ? (
                  <span className="text-xs text-amber-600" data-testid="gpu-measure-mismatch">
                    {measureMismatch}
                  </span>
                ) : null}
              </div>
            </fieldset>
          )}

          {/* ---------------------- desktop force-dGPU toggle ---------------------- */}
          {isTauri() && forceFlag !== null && (
            <div className="grid gap-2 rounded-lg border border-border-strong px-3 py-3" data-testid="gpu-force-block">
              <label className="flex min-h-6 items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  data-testid="gpu-force-toggle"
                  checked={forceFlag}
                  disabled={forceBusy}
                  onChange={(e) => void toggleForce(e.target.checked)}
                />
                {t('settings.gpu_force_title')}
              </label>
              <p className="text-xs text-text-muted">{t('settings.gpu_force_hint')}</p>
              {collapsedSingle && !forceFlag && (
                <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="gpu-force-suggestion">
                  {t('settings.gpu_force_suggestion')}
                </p>
              )}
              {forceRecoveryRow && (
                <div className="rounded-lg border border-tone-red bg-tone-red-soft px-3 py-2 text-xs" role="alert" data-testid="gpu-force-recovery">
                  <p>{t('settings.gpu_force_recovery')}</p>
                  <button
                    type="button"
                    data-testid="gpu-force-revert"
                    className="mt-2 min-h-8 rounded-lg bg-accent px-3 text-sm font-semibold text-text-on-accent"
                    onClick={() => void toggleForce(false)}
                  >
                    {t('settings.gpu_force_revert')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ---------------------- diagnostics table ---------------------- */}
          {discovery && (
            <details data-testid="gpu-diagnostics">
              <summary className="cursor-pointer text-sm font-semibold">
                {t('settings.gpu_diag_title')}
              </summary>
              <table className="mt-2 w-full text-left text-xs">
                <caption className="sr-only">{t('settings.gpu_diag_title')}</caption>
                <thead>
                  <tr className="border-b border-border-strong">
                    <th scope="col" className="py-1 pr-2 font-semibold">{t('settings.gpu_diag_probe')}</th>
                    <th scope="col" className="py-1 pr-2 font-semibold">{t('settings.gpu_diag_fingerprint')}</th>
                    <th scope="col" className="py-1 pr-2 font-semibold">{t('settings.gpu_diag_software')}</th>
                    <th scope="col" className="py-1 font-semibold">{t('settings.gpu_diag_maxbuffer')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border-strong">
                    <th scope="row" className="py-1 pr-2 font-normal">navigator.gpu</th>
                    <td className="py-1 pr-2" data-testid="gpu-diag-webgpu">{state.hardware.webgpu ? '✓' : '✗'}</td>
                    <td className="py-1 pr-2">—</td>
                    <td className="py-1">—</td>
                  </tr>
                  {(['hp', 'lp'] as const).map((slot) => {
                    const probe = discovery.probes[slot];
                    return (
                      <tr key={slot} className="border-b border-border-strong">
                        <th scope="row" className="py-1 pr-2 font-normal">
                          {slot === 'hp' ? t('settings.gpu_diag_hp') : t('settings.gpu_diag_lp')}
                        </th>
                        <td className="py-1 pr-2">{probe?.fingerprint ?? '—'}</td>
                        <td className="py-1 pr-2">
                          {probe ? String(probe.isFallbackAdapter ?? '?') : '—'}
                        </td>
                        <td className="py-1">
                          {probe?.maxBufferSize != null
                            ? t('settings.gpu_diag_gb', { gb: +(probe.maxBufferSize / 1024 ** 3).toFixed(1) })
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <th scope="row" className="py-1 pr-2 font-normal">{t('settings.gpu_diag_active')}</th>
                    <td className="py-1 pr-2" colSpan={3} data-testid="gpu-diag-active">
                      {(() => {
                        const { resolved } = resolveChoice(storedChoice, discovery);
                        return resolved.kind === 'cpu'
                          ? t('settings.gpu_diag_active_cpu')
                          : `${resolved.fingerprint}${resolved.powerPreference ? ` (${resolved.powerPreference})` : ''}`;
                      })()}
                    </td>
                  </tr>
                </tbody>
              </table>
              {/* Windows per-app graphics guidance (vi/en) — honest: the app
                  can only REQUEST an adapter. */}
              <p className="mt-2 text-xs text-text-muted">{t('settings.gpu_windows_note')}</p>
            </details>
          )}

          {rec ? (
            <p className="text-xs text-text-muted" data-testid="settings-bench">
              {t('settings.hw_bench_line', {
                tokens: rec.tokPerSecWarm,
                condition: rec.condition,
                date: new Date(rec.measuredAt).toLocaleString(),
              })}
            </p>
          ) : (
            <p className="text-xs text-text-muted">{t('settings.hw_no_bench')}</p>
          )}
          {stale ? (
            <p className="text-xs text-amber-600" data-testid="settings-bench-stale">
              {t('settings.hw_stale')}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="settings-remeasure"
              disabled={!modelCached || measuring || !state.hardware.adapter}
              onClick={() => {
                const fp = state.hardware.adapter
                  ? adapterFingerprint(state.hardware.adapter)
                  : null;
                if (!fp) return;
                const adapter = discovery?.adapters.find((a) => a.fingerprint === fp);
                if (adapter) void measure(adapter);
              }}
              className="min-h-9 rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            >
              {measuring ? t('settings.hw_measuring') : t('settings.hw_remeasure')}
            </button>
            {!modelCached ? (
              <span className="text-xs text-text-muted">{t('settings.hw_remeasure_needs_model')}</span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-text-muted">{t('settings.hw_loading')}</p>
      )}
    </section>
  );
}
