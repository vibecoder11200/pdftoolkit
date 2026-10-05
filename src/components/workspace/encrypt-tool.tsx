import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';

type ProtectMode = 'encrypt' | 'decrypt';

// Worker must never hang the UI: every engine call races against this timeout.
// The value is surfaced in the `protect.err_timeout` locale copy (60 seconds).
const WORKER_TIMEOUT_MS = 60_000;
const TIMEOUT_SENTINEL = 'protect-timeout';

interface RunError {
  key: string;
  values?: Record<string, string | number>;
}

function withWorkerTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_SENTINEL)), WORKER_TIMEOUT_MS);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

function outputName(original: string, mode: ProtectMode): string {
  const base = original.replace(/\.pdf$/i, '').trim() || (mode === 'encrypt' ? 'encrypted' : 'decrypted');
  return mode === 'encrypt' ? `${base}-encrypted.pdf` : `${base}-decrypted.pdf`;
}

export function EncryptTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  const [mode, setMode] = useState<ProtectMode>('encrypt');
  // Passwords live in state only while the user types / the worker runs and
  // are wiped in the `finally` of every run plus on reset (never kept after done).
  const [userPass, setUserPass] = useState('');
  const [ownerPass, setOwnerPass] = useState('');
  const [bits, setBits] = useState<128 | 256>(256);
  const [decryptPass, setDecryptPass] = useState('');
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  const src = files.length > 0 ? files[0] : null;

  const clearPasswords = () => {
    setUserPass('');
    setOwnerPass('');
    setDecryptPass('');
  };

  const resetAll = () => {
    clear();
    clearPasswords();
    setProgress(null);
    setRunError(null);
    setSucceeded(false);
  };

  const switchMode = (next: ProtectMode) => {
    setMode(next);
    clearPasswords();
    setProgress(null);
    setRunError(null);
    setSucceeded(false);
  };

  const run = async () => {
    setRunError(null);
    setSucceeded(false);
    if (!src) {
      setRunError({ key: 'protect.err_no_file' });
      return;
    }
    setBusy(true);
    try {
      if (mode === 'encrypt') {
        // engine.encryptPdf(bytes, user, owner, bits?) defaults to 256 (AES-256).
        // Spike S1 (docs/SPIKES.md): 256 ships by default; the 128 fallback MUST
        // be 128-AES (`--use-aes=y`, see src/engine/qpdf.ts), never bare RC4
        // (qpdf >= 12 refuses RC4 without --allow-weak-crypto).
        // Permissions: the frozen ENGINE-API (docs/ENGINE-API.md) exposes only
        // user/owner passwords — no granular permission flags — so the owner
        // password field below is the full permissions control available.
        if (!userPass) {
          setRunError({ key: 'protect.err_no_password' });
          return;
        }
        setProgress({ value: 20, label: t('protect.progress_encrypting') });
        const owner = ownerPass || userPass;
        const out = await withWorkerTimeout(engine.encryptPdf(src.bytes, userPass, owner, bits));
        setProgress({ value: 100, label: t('protect.progress_done') });
        downloadBytes(out, outputName(src.file.name, 'encrypt'));
        setSucceeded(true);
      } else {
        if (!decryptPass) {
          setRunError({ key: 'protect.err_no_password' });
          return;
        }
        setProgress({ value: 20, label: t('protect.progress_decrypting') });
        const out = await withWorkerTimeout(engine.decryptPdf(src.bytes, decryptPass));
        setProgress({ value: 100, label: t('protect.progress_done') });
        downloadBytes(out, outputName(src.file.name, 'decrypt'));
        setSucceeded(true);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === TIMEOUT_SENTINEL) {
        setRunError({ key: 'protect.err_timeout' });
      } else if (mode === 'decrypt') {
        // Wrong password is the overwhelmingly common decrypt failure
        // (qpdf exits non-zero / pdf-lib reload rejects); surface it clearly.
        setRunError({ key: 'protect.err_wrong_password' });
      } else {
        setRunError({ key: 'protect.err_failed', values: { message } });
      }
      setProgress(null);
    } finally {
      // Never keep the password in state after the run finishes.
      clearPasswords();
      setBusy(false);
    }
  };

  const fileErrorParts = (() => {
    if (!fileError) return null;
    const idx = fileError.indexOf(':');
    const code = idx === -1 ? fileError : fileError.slice(0, idx);
    const name = idx === -1 ? '' : fileError.slice(idx + 1);
    if (code === 'too-large') return { key: 'protect.err_too_large', values: { name } };
    if (code === 'not-pdf') return { key: 'protect.err_not_pdf', values: { name } };
    if (code === 'heic-refused') return { key: 'protect.err_heic', values: { name } };
    return null;
  })();

  const error = fileErrorParts
    ? t(fileErrorParts.key, fileErrorParts.values)
    : runError
      ? t(runError.key, runError.values)
      : null;

  const canRun =
    !busy && src != null && (mode === 'encrypt' ? userPass.length > 0 : decryptPass.length > 0);

  return (
    <WorkspaceShell
      title={t('protect.title')}
      meta={src ? `${src.file.name} · ${formatBytes(src.file.size, locale)}` : undefined}
      steps={[
        { label: '1', state: src ? 'done' : 'now' },
        { label: '2', state: succeeded ? 'done' : src ? 'now' : 'todo' },
        { label: '3', state: succeeded ? 'now' : 'todo' },
      ]}
      error={error}
      side={
        <>
          <Button onClick={() => void run()} disabled={!canRun}>
            {mode === 'encrypt' ? t('protect.cta_encrypt') : t('protect.cta_decrypt')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-slate-500">{t('protect.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <div className="flex gap-2" role="tablist" aria-label={t('protect.title')}>
        {(['encrypt', 'decrypt'] as ProtectMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => switchMode(m)}
            className={`inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border px-4 text-sm font-semibold ${
              mode === m
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t(m === 'encrypt' ? 'protect.tab_encrypt' : 'protect.tab_decrypt')}
          </button>
        ))}
      </div>

      <div className="mt-3.5">
        <Dropzone
          title={t('protect.dropzone_title')}
          hint={t('protect.dropzone_hint')}
          accept="application/pdf,.pdf"
          multiple={false}
          onFiles={(f) => {
            if (f.length === 0) return;
            clear();
            setProgress(null);
            setRunError(null);
            setSucceeded(false);
            void add([f[0]]);
          }}
        />
      </div>

      {src ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-slate-200 p-2.5 text-[13.5px]">
          <span>📄</span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{src.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-slate-500 tabular-nums">
            {formatBytes(src.file.size, locale)}
          </span>
        </div>
      ) : null}

      {mode === 'encrypt' ? (
        <>
          <div
            className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[13.5px]"
            role="note"
          >
            <strong className="block text-amber-900">{t('protect.warn_title')}</strong>
            <span className="text-amber-900">{t('protect.warn_forgot')}</span>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <label className="block text-sm">
              <span className="mb-1 block font-bold">{t('protect.user_pass_label')}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={userPass}
                onChange={(e) => setUserPass(e.target.value)}
                placeholder={t('protect.user_pass_placeholder')}
                className="min-h-11 w-full rounded-lg border border-slate-300 px-3.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold">{t('protect.owner_pass_label')}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={ownerPass}
                onChange={(e) => setOwnerPass(e.target.value)}
                placeholder={t('protect.owner_pass_placeholder')}
                className="min-h-11 w-full rounded-lg border border-slate-300 px-3.5 text-sm"
              />
              <span className="mt-1 block text-[13px] text-slate-500">
                {t('protect.owner_pass_hint')}
              </span>
            </label>
          </div>

          <fieldset className="mt-4">
            <legend className="text-sm font-bold">{t('protect.bits_label')}</legend>
            <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={t('protect.bits_label')}>
              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                  bits === 256 ? 'border-indigo-600 bg-white' : 'border-slate-300 bg-white'
                }`}
              >
                <input
                  type="radio"
                  name="protect-bits"
                  value="256"
                  checked={bits === 256}
                  onChange={() => setBits(256)}
                  className="mt-1 h-4 w-4 accent-indigo-600"
                />
                <span>
                  <span className="block font-semibold">{t('protect.bits_256')}</span>
                  <span className="block text-[13px] text-slate-500">{t('protect.bits_256_hint')}</span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                  bits === 128 ? 'border-indigo-600 bg-white' : 'border-slate-300 bg-white'
                }`}
              >
                <input
                  type="radio"
                  name="protect-bits"
                  value="128"
                  checked={bits === 128}
                  onChange={() => setBits(128)}
                  className="mt-1 h-4 w-4 accent-indigo-600"
                />
                <span>
                  <span className="block font-semibold">{t('protect.bits_128')}</span>
                  <span className="block text-[13px] text-slate-500">{t('protect.bits_128_hint')}</span>
                </span>
              </label>
            </div>
            <p className="mt-2 text-[13px] text-slate-500">{t('protect.bits_note')}</p>
          </fieldset>
        </>
      ) : (
        <div className="mt-4">
          <label className="block text-sm">
            <span className="mb-1 block font-bold">{t('protect.decrypt_pass_label')}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={decryptPass}
              onChange={(e) => setDecryptPass(e.target.value)}
              placeholder={t('protect.decrypt_pass_placeholder')}
              className="min-h-11 w-full rounded-lg border border-slate-300 px-3.5 text-sm"
            />
          </label>
        </div>
      )}
    </WorkspaceShell>
  );
}
