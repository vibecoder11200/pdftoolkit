import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { CertKeyInfo } from '../../engine/p12';
import { engine } from '../../engine/client';
import { Button } from '../ui/button';

const P12_MAX_BYTES = 10 * 1024 * 1024;

export interface CertCredentials {
  file: File;
  password: string;
}

interface SignCertPanelProps {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  /** Mutual exclusivity: checking cert mode unchecks the self-sign toggle. */
  onExclusive: () => void;
  ack: boolean;
  onAckChange: (v: boolean) => void;
  disabled: boolean;
  /** The tool reads {file, password} at sign time. */
  credentialsRef: RefObject<CertCredentials | null>;
  /** Mapped inspect errors surface through the tool's run-error banner. */
  onError: (err: { key: string; values?: Record<string, string | number> } | null) => void;
  /**
   * Wipe handles the tool calls: `all()` on success/reset/disable (nothing
   * left over), `password()` on a wrong-password retry (F7: keep the file).
   */
  onWipeRef: RefObject<{ all: () => void; password: () => void }>;
}

type CertUiError = { key: string; values?: Record<string, string | number> };

/*
 * "Chứng thư thật" mode (v0.3.0 phase 5). Password NEVER enters React state
 * (red-team F7): it lives in a ref written by the uncontrolled input, is
 * wiped by onWipeRef (tool calls it after sign / bad-password / reset), and
 * crosses to the worker exactly once per operation — the private key itself
 * never leaves the worker (docs/ENGINE-API.md).
 */
export function SignCertPanel({
  enabled,
  onEnabledChange,
  onExclusive,
  ack,
  onAckChange,
  disabled,
  credentialsRef,
  onError,
  onWipeRef,
}: SignCertPanelProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const passInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<CertKeyInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const wipePassword = () => {
    credentialsRef.current = null;
    if (passInputRef.current) passInputRef.current.value = '';
  };
  const wipeAll = () => {
    wipePassword();
    setFile(null);
    setMeta(null);
  };
  onWipeRef.current = { all: wipeAll, password: wipePassword };

  // Unmount (or reset) must leave no password copy behind.
  useEffect(() => () => wipePassword(), []);

  const onP12Selected = (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    onError(null);
    if (f.size > P12_MAX_BYTES) {
      onError({ key: 'sign.cert_too_large' });
      return;
    }
    // New bundle invalidates everything the previous one produced.
    credentialsRef.current = null;
    if (passInputRef.current) passInputRef.current.value = '';
    setMeta(null);
    setFile(f);
  };

  const inspect = async () => {
    if (!file) {
      onError({ key: 'sign.cert_err_no_file' });
      return;
    }
    const password = passInputRef.current?.value ?? '';
    setInspecting(true);
    onError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await engine.inspectCertificateKey(bytes, password);
      credentialsRef.current = { file, password };
      setMeta(info);
    } catch (e) {
      credentialsRef.current = null;
      setMeta(null);
      onError(mapCertError(e));
    } finally {
      setInspecting(false);
    }
  };

  const now = Date.now();
  const expired = meta ? meta.notAfterMs < now : false;
  const notYet = meta ? meta.notBeforeMs > now : false;
  const daysLeft = meta ? Math.ceil((meta.notAfterMs - now) / 24 / 60 / 60 / 1000) : 0;

  return (
    <>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-strong bg-surface-card px-3.5 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => {
            onEnabledChange(e.target.checked);
            if (e.target.checked) {
              onExclusive();
              onAckChange(false);
            } else {
              wipeAll();
              onAckChange(false);
            }
          }}
          className="mt-0.5 h-4 w-4 accent-accent"
        />
        <span>
          <span className="block font-semibold">{t('sign.cert_label')}</span>
          <span className="block text-[13px] text-text-muted">{t('sign.cert_hint')}</span>
        </span>
      </label>
      {enabled ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border-default p-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".p12,.pfx,application/x-pkcs12"
            className="hidden"
            data-testid="cert-file-input"
            onChange={(e) => {
              onP12Selected(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? t('sign.cert_change') : t('sign.cert_pick')}
            </Button>
            {file ? (
              <span className="min-w-0 truncate text-[13px] text-text-muted">{file.name}</span>
            ) : null}
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-bold">{t('sign.cert_pass_label')}</span>
            <input
              ref={passInputRef}
              type="password"
              autoComplete="off"
              data-testid="cert-password"
              className="block w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2 text-sm"
              onInput={() => {
                // A changed password invalidates the previous inspection.
                credentialsRef.current = null;
                setMeta(null);
              }}
            />
          </label>
          <div>
            <Button variant="secondary" size="sm" disabled={disabled || inspecting || !file} onClick={() => void inspect()}>
              {t('sign.cert_inspect')}
            </Button>
          </div>
          {meta ? (
            <div className="flex flex-col gap-1 rounded-lg border border-border-default bg-surface-page px-3 py-2.5 text-[13px]">
              <span className="font-semibold text-text-primary">{meta.cn}</span>
              <span className="text-text-muted">
                {t('sign.cert_info_issuer', { issuer: meta.issuerCn })}
              </span>
              <span className="text-text-muted">
                {t('sign.cert_info_key', { type: meta.keyType, bits: meta.keyBits })}
              </span>
              <span className="text-text-muted tabular-nums">
                {t('sign.cert_info_valid', {
                  from: new Date(meta.notBeforeMs).toLocaleDateString(),
                  to: new Date(meta.notAfterMs).toLocaleDateString(),
                })}
              </span>
              {expired ? (
                <span className="text-warning">{t('sign.cert_warn_expired')}</span>
              ) : notYet ? (
                <span className="text-warning">
                  {t('sign.cert_warn_not_yet', { date: new Date(meta.notBeforeMs).toLocaleDateString() })}
                </span>
              ) : daysLeft <= 30 ? (
                <span className="text-warning">{t('sign.cert_warn_soon', { days: daysLeft })}</span>
              ) : null}
              {meta.missingIntermediate ? (
                <span className="text-warning">{t('sign.cert_warn_chain')}</span>
              ) : null}
            </div>
          ) : null}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-default px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => onAckChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span className="text-[13px] text-text-muted">{t('sign.cert_ack')}</span>
          </label>
        </div>
      ) : null}
    </>
  );
}

/**
 * comlink preserves Error.name — the UI maps by name and shows its OWN copy,
 * never the raw library message (red-team F7; contract in docs/ENGINE-API.md).
 */
export function mapCertError(e: unknown): CertUiError {
  const name = (e as Error)?.name;
  if (name === 'CertBadPassword') return { key: 'sign.cert_bad_password' };
  if (name === 'CertTooLarge') return { key: 'sign.cert_too_large' };
  if (name === 'CertAlreadySigned') return { key: 'sign.err_already_signed' };
  if (name === 'CertInvalid') return { key: 'sign.cert_invalid' };
  return { key: 'sign.cert_invalid' };
}
