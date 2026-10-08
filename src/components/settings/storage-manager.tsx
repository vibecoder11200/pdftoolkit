import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  collectStorageSnapshot,
  defaultStorageDeps,
  deleteOcrIdb,
  deleteOcrRuntime,
  deletePrecacheAndReload,
  type StorageDeps,
  type StorageRow,
  type StorageRowId,
  type StorageSnapshot,
} from '../../lib/storage-rows';
import { AI_CACHE_STORE, AI_MODEL_ID } from '../../lib/ai-models';
import { sharedAiClient } from '../../lib/ai-worker-client';
import { hasActiveJob } from '../../lib/jobs';
import { formatBytes } from '../../lib/format';

/** e2e mock seam (F8) — same page-URL flag the OCR tool reads. */
const isAiMock = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ai-mock');

const ROW_ORDER: StorageRowId[] = ['ai-model', 'ocr-assets', 'ocr-idb', 'precache'];

function rowTitleKey(id: StorageRowId): string {
  return `settings.row_${id.replace(/-/g, '_')}`;
}

function QuotaBar({ snapshot }: { snapshot: StorageSnapshot }) {
  const { t } = useTranslation();
  if (snapshot.quota === null || snapshot.quota <= 0) return null;
  const pct = Math.min(100, Math.round(((snapshot.usage ?? 0) / snapshot.quota) * 100));
  return (
    <div className="mb-4" data-testid="settings-quota">
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-hover">
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-text-muted">
        {t('settings.quota_line', {
          usage: formatBytes(snapshot.usage ?? 0),
          quota: formatBytes(snapshot.quota),
        })}
      </p>
    </div>
  );
}

export function StorageManager() {
  const { t } = useTranslation();
  const [deps] = useState<StorageDeps>(() => defaultStorageDeps());
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [busy, setBusy] = useState<StorageRowId | null>(null);
  const [clearAll, setClearAll] = useState(false);

  const refresh = useCallback(() => {
    void collectStorageSnapshot(deps).then(setSnapshot);
  }, [deps]);

  useEffect(refresh, [refresh]);

  const jobRunning = hasActiveJob();

  const deleteRow = useCallback(
    async (id: StorageRowId) => {
      if (busy) return;
      setBusy(id);
      try {
        if (id === 'ai-model') {
          // Pipeline cache + manifest entries through the worker (comlink),
          // then the store itself for anything outside the manifest.
          await sharedAiClient({ mock: isAiMock() }).clearCache(AI_MODEL_ID);
          await deps.deleteCacheStore(AI_CACHE_STORE);
        } else if (id === 'ocr-assets') {
          await deleteOcrRuntime(deps);
        } else if (id === 'ocr-idb') {
          await deleteOcrIdb(deps);
        } else if (id === 'precache') {
          await deletePrecacheAndReload(deps);
          return;
        }
        refresh();
      } finally {
        setBusy(null);
      }
    },
    [busy, deps, refresh],
  );

  const deleteAllAi = useCallback(async () => {
    if (busy || clearAll) return;
    setClearAll(true);
    try {
      await sharedAiClient({ mock: isAiMock() }).clearCache(AI_MODEL_ID);
      await deps.deleteCacheStore(AI_CACHE_STORE);
      await deleteOcrRuntime(deps);
      refresh();
    } finally {
      setClearAll(false);
    }
  }, [busy, clearAll, deps, refresh]);

  const rows = useMemo(() => {
    const byId = new Map(snapshot?.rows.map((r) => [r.id, r]) ?? []);
    return ROW_ORDER.map((id) => byId.get(id)).filter((r): r is StorageRow => r !== undefined);
  }, [snapshot]);

  return (
    <section aria-labelledby="settings-storage" className="mt-10">
      <h2 id="settings-storage" className="text-lg font-bold">
        {t('settings.storage_title')}
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm text-text-muted">{t('settings.storage_intro')}</p>
      {snapshot ? <QuotaBar snapshot={snapshot} /> : null}
      <div className="mt-3 overflow-hidden rounded-xl border border-border-strong" data-testid="settings-rows">
        {rows.map((row) => {
          const deleting = busy === row.id;
          const disabled = row.disabled || jobRunning || (busy !== null && !deleting);
          return (
            <div
              key={row.id}
              data-testid={`row-${row.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border-default px-4 py-3 last:border-b-0"
            >
              <div className="min-w-56 flex-1">
                <p className="text-sm font-semibold">{t(rowTitleKey(row.id))}</p>
                <p className="text-xs text-text-muted">{t(`settings.row_${row.id.replace(/-/g, '_')}_hint`)}</p>
              </div>
              <span
                data-testid={`size-${row.id}`}
                className="min-w-20 text-right text-sm tabular-nums text-text-muted"
              >
                {row.present
                  ? row.bytes === null
                    ? t('settings.size_unknown')
                    : formatBytes(row.bytes)
                  : t('settings.not_downloaded')}
              </span>
              {row.id === 'precache' && row.disabled ? (
                <span className="text-xs text-text-muted">{t('settings.precache_offline')}</span>
              ) : null}
              {row.present ? (
                <button
                  type="button"
                  data-testid={`delete-${row.id}`}
                  disabled={disabled || deleting}
                  onClick={() => void deleteRow(row.id)}
                  className="min-h-9 rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
                >
                  {deleting ? t('settings.deleting') : t('settings.delete')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {snapshot && (snapshot.unknownCaches.length > 0 || snapshot.unknownDbs.length > 0) ? (
        <div className="mt-4 rounded-xl border border-border-default bg-surface-card px-4 py-3" data-testid="settings-unknown">
          <p className="text-sm font-semibold">{t('settings.unknown_title')}</p>
          <p className="mt-0.5 text-xs text-text-muted">{t('settings.unknown_hint')}</p>
          <ul className="mt-1.5 list-inside list-disc text-xs text-text-muted">
            {snapshot.unknownCaches.map((n) => (
              <li key={`c:${n}`}>{n}</li>
            ))}
            {snapshot.unknownDbs.map((n) => (
              <li key={`d:${n}`}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="delete-all-ai"
          disabled={busy !== null || clearAll || jobRunning}
          onClick={() => void deleteAllAi()}
          className="min-h-9 rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
        >
          {clearAll ? t('settings.deleting') : t('settings.delete_all_ai')}
        </button>
        <p className="text-xs text-text-muted">{t('settings.in_memory_note')}</p>
      </div>
    </section>
  );
}
