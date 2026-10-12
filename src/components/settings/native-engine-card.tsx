import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getNativeStatus, sharedNativeClient } from '../../lib/ai-native-client';
import type { NativeStatus } from '../../lib/native-types';
import { isTauri } from '../../lib/platform';
import { probeAdapters } from '../../lib/gpu-choice';
import { useActiveJob } from '../../hooks/use-active-job';
import { formatBytes } from '../../lib/format';

/*
 * Settings "Engine Native (beta)" card (v0.6.0 phase 5, R5.2/R5.3).
 * Desktop-only; drives the SAME sharedNativeClient() singleton as the OCR
 * tool (review F1 — one download stream, visible in both surfaces). The
 * CUDA row is ALWAYS visible (validation V2: the motivating machine
 * reports WebGPU=Intel despite an RTX 3050, so hiding the row behind the
 * WebGPU hint would hide CUDA from exactly the first real user); its
 * install button enables on an NVIDIA hit from EITHER the engine probe
 * (authoritative) or the WebGPU vendor string (pre-install hint).
 */

const NATIVE_PHASE_KEYS: Record<string, string> = {
  notInstalled: 'settings.native_phase_notinstalled',
  versionChecking: 'settings.native_phase_checking',
  starting: 'settings.native_phase_starting',
  ready: 'settings.native_phase_ready',
  stopping: 'settings.native_phase_stopping',
  stopped: 'settings.native_phase_stopped',
  dead: 'settings.native_phase_dead',
};

function hasNvidia(devices: string[]): boolean {
  return devices.some((d) => d.toLowerCase().includes('nvidia'));
}

type ProgressState = { percent: number | null; active: boolean };

export function NativeEngineCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [probe, setProbe] = useState<string[]>([]);
  const [webgpuNvidia, setWebgpuNvidia] = useState(false);
  const [engineDl, setEngineDl] = useState<ProgressState>({ percent: null, active: false });
  const [modelDl, setModelDl] = useState<ProgressState>({ percent: null, active: false });
  const [cudaDl, setCudaDl] = useState<ProgressState>({ percent: null, active: false });
  const [error, setError] = useState<string | null>(null);
  const jobActive = useActiveJob();

  const refresh = useCallback(() => {
    void getNativeStatus().then((st) => {
      setStatus(st);
      // The engine probe only exists once the engine is installed — chain it.
      if (st?.enginePresent && probe.length === 0) {
        void sharedNativeClient()
          .probeDevices()
          .then(setProbe)
          .catch(() => undefined);
      }
    });
    // WebGPU vendor hint (pre-install; MISSES the motivating machine by
    // design — the row's visibility is never gated on it, R5.3).
    void probeAdapters()
      .then((d) => setWebgpuNvidia(d.adapters.some((a) => (a.info.vendor ?? '').toLowerCase().includes('nvidia'))))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(refresh, [refresh]);

  if (!isTauri()) return null;

  const nvidiaDetected = hasNvidia(probe) || webgpuNvidia;
  const cudaPresent = !!status?.cudaPresent;
  const running = status?.phase === 'ready' || status?.phase === 'starting';

  const runDownload = useCallback(
    async (kind: 'engine' | 'model' | 'cuda') => {
      if (error) setError(null);
      const setter = kind === 'engine' ? setEngineDl : kind === 'model' ? setModelDl : setCudaDl;
      setter({ percent: 0, active: true });
      try {
        await sharedNativeClient()[
          kind === 'engine' ? 'downloadEngine' : kind === 'model' ? 'downloadModelOnly' : 'downloadCuda'
        ]((p) => setter({ percent: p.percent, active: true }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setter({ percent: null, active: false });
        refresh();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refresh],
  );

  const runDelete = useCallback(
    async (kind: 'engine' | 'model' | 'cuda') => {
      try {
        await sharedNativeClient().deleteKind(kind);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setProbe([]);
        refresh();
      }
    },
    [refresh],
  );

  const phaseKey = status ? (NATIVE_PHASE_KEYS[status.phase] ?? status.phase) : null;

  return (
    <section aria-labelledby="settings-native" className="mt-10" data-testid="native-engine-card">
      <h2 id="settings-native" className="text-lg font-bold">
        {t('settings.native_title')}
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm text-text-muted">{t('settings.native_intro')}</p>
      <div className="mt-3 grid gap-3 rounded-xl border border-border-strong px-4 py-3">
        {/* ------------------------------ status ------------------------------ */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{t('settings.native_status')}:</span>
          <span data-testid="native-status">{phaseKey ? t(phaseKey) : t('settings.native_status_unknown')}</span>
          {status?.backend && status.backend !== 'unknown' && (
            <span className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">
              {t('settings.native_backend_label', { backend: status.backend })}
            </span>
          )}
          {running && (
            <button
              type="button"
              data-testid="native-stop"
              className="min-h-8 rounded border border-border-strong px-2 py-0.5 text-xs hover:bg-surface-hover"
              onClick={() => void sharedNativeClient().stop().then(refresh)}
            >
              {t('settings.native_stop')}
            </button>
          )}
        </div>
        {status && status.devices && status.devices.length > 0 && (
          <p className="text-xs text-text-muted" data-testid="native-devices">
            {status.devices.join(' · ')}
          </p>
        )}
        {status?.lastError && (
          <p className="rounded-lg border border-tone-red bg-tone-red-soft px-3 py-2 text-xs" role="alert" data-testid="native-last-error">
            {t(`ocr.native_err_${status.lastError.kind.replace(/-/g, '_')}`, {
              defaultValue: status.lastError.detail ?? status.lastError.kind,
              detail: status.lastError.detail ?? '',
            })}
          </p>
        )}

        {/* --------------------------- engine install --------------------------- */}
        <DownloadRow
          testid="native-download-engine"
          label={t('settings.native_engine_dl', { size: formatBytes(33_500_000) })}
          present={!!status?.enginePresent}
          bytes={status?.sizes.engine ?? 0}
          progress={engineDl}
          jobActive={jobActive}
          onDownload={() => void runDownload('engine')}
          onCancel={() => void sharedNativeClient().cancelDownload().then(refresh)}
          onDelete={() => void runDelete('engine')}
          deleteLabel={t('settings.delete')}
        />

        {/* ---------------------------- model install ---------------------------- */}
        <DownloadRow
          testid="native-download-model"
          label={t('settings.native_model_dl', { size: formatBytes(1_434_837_056) })}
          present={!!status?.modelPresent}
          bytes={status?.sizes.model ?? 0}
          progress={modelDl}
          jobActive={jobActive}
          onDownload={() => void runDownload('model')}
          onCancel={() => void sharedNativeClient().cancelDownload().then(refresh)}
          onDelete={() => void runDelete('model')}
          deleteLabel={t('settings.delete')}
        />

        {/* ------------------------------ CUDA opt-in ------------------------------ */}
        <div className="grid gap-1 rounded-lg border border-border-default px-3 py-2" data-testid="native-cuda-row">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{t('settings.native_cuda_title')}</span>
            {cudaPresent && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
                {t('settings.native_cuda_installed')}
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted">{t('settings.native_cuda_hint')}</p>
          {cudaPresent ? (
            <button
              type="button"
              data-testid="native-cuda-delete"
              disabled={jobActive || running}
              className="min-h-9 w-fit rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-hover disabled:opacity-50"
              onClick={() => void runDelete('cuda')}
            >
              {t('settings.native_cuda_remove')}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="native-cuda-download"
                disabled={!nvidiaDetected || cudaDl.active || jobActive}
                className="min-h-9 w-fit rounded-lg bg-accent px-3 text-sm font-semibold text-text-on-accent disabled:opacity-50"
                onClick={() => void runDownload('cuda')}
              >
                {cudaDl.active
                  ? t('settings.native_dl_progress', { percent: cudaDl.percent ?? 0 })
                  : t('settings.native_cuda_install', { size: formatBytes(600_000_000) })}
              </button>
              {!nvidiaDetected && (
                <span className="text-xs text-text-muted">{t('settings.native_cuda_needs_nvidia')}</span>
              )}
            </div>
          )}
          {cudaDl.active && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${cudaDl.percent ?? 0}%` }} />
            </div>
          )}
        </div>

        {error && (
          <p className="text-xs text-tone-red" role="alert" data-testid="native-card-error">
            {error}
          </p>
        )}
        <p className="text-xs text-text-muted">{t('settings.native_resume_note')}</p>
      </div>
    </section>
  );
}

function DownloadRow({
  testid,
  label,
  present,
  bytes,
  progress,
  jobActive,
  onDownload,
  onCancel,
  onDelete,
  deleteLabel,
}: {
  testid: string;
  label: string;
  present: boolean;
  bytes: number;
  progress: ProgressState;
  jobActive: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  deleteLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1 rounded-lg border border-border-default px-3 py-2" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{label}</span>
        {present ? (
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
            {formatBytes(bytes)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!present && !progress.active && (
          <button
            type="button"
            data-testid={`${testid}-start`}
            disabled={jobActive}
            className="min-h-9 rounded-lg bg-accent px-3 text-sm font-semibold text-text-on-accent disabled:opacity-50"
            onClick={onDownload}
          >
            {t('settings.native_download')}
          </button>
        )}
        {progress.active && (
          <>
            <span className="text-xs tabular-nums" data-testid={`${testid}-percent`}>
              {t('settings.native_dl_progress', { percent: progress.percent ?? 0 })}
            </span>
            <button
              type="button"
              data-testid={`${testid}-cancel`}
              className="min-h-8 rounded border border-border-strong px-2 py-0.5 text-xs hover:bg-surface-hover"
              onClick={onCancel}
            >
              {t('ocr.ai_cancel_download')}
            </button>
          </>
        )}
        {present && (
          <button
            type="button"
            data-testid={`${testid}-delete`}
            disabled={jobActive}
            className="min-h-8 rounded border border-border-strong px-2 py-0.5 text-xs hover:bg-surface-hover disabled:opacity-50"
            onClick={onDelete}
          >
            {deleteLabel}
          </button>
        )}
      </div>
      {progress.active && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress.percent ?? 0}%` }} />
        </div>
      )}
    </div>
  );
}
