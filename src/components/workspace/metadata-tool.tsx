import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PDFDocument } from 'pdf-lib';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { sniffPdfMagic } from '../../lib/file-accept';
import { canSaveElsewhere, deliverBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { WorkspaceShell } from './workspace-shell';
import { FileIcon } from '../ui/icons';

interface MetadataForm {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

interface RunError {
  key: string;
  values?: Record<string, string | number>;
}

const EMPTY_FORM: MetadataForm = {
  title: '',
  author: '',
  subject: '',
  keywords: '',
  creator: '',
  producer: '',
};

const FIELDS: { key: keyof MetadataForm; labelKey: string }[] = [
  { key: 'title', labelKey: 'metadata.field_title' },
  { key: 'author', labelKey: 'metadata.field_author' },
  { key: 'subject', labelKey: 'metadata.field_subject' },
  { key: 'keywords', labelKey: 'metadata.field_keywords' },
  { key: 'creator', labelKey: 'metadata.field_creator' },
  { key: 'producer', labelKey: 'metadata.field_producer' },
];

function outputName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'document';
  return `${base}-metadata.pdf`;
}

export function MetadataTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const [form, setForm] = useState<MetadataForm>(EMPTY_FORM);
  // Snapshot of the original CreationDate so save() can restore it byte-identically.
  const [creationDate, setCreationDate] = useState<Date | null>(null);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  const src = files.length > 0 ? files[0] : null;

  useEffect(() => {
    const gen = (genRef.current += 1);
    setLoadErrorKey(null);
    setRunError(null);
    setProgress(null);
    if (!src) {
      setForm(EMPTY_FORM);
      setCreationDate(null);
      return;
    }
    void (async () => {
      try {
        // Belt-and-braces %PDF- check on the actual bytes (useDropFiles already
        // ran checkPdfFile, which sniffs the head magic bytes).
        if (!sniffPdfMagic(src.bytes)) {
          if (genRef.current !== gen) return;
          setForm(EMPTY_FORM);
          setCreationDate(null);
          setLoadErrorKey('metadata.err_not_pdf');
          return;
        }
        // pdf-lib getters on the main thread; the frozen worker is untouched.
        const doc = await PDFDocument.load(src.bytes.slice());
        if (genRef.current !== gen) return;
        setForm({
          title: doc.getTitle() ?? '',
          author: doc.getAuthor() ?? '',
          subject: doc.getSubject() ?? '',
          keywords: doc.getKeywords() ?? '',
          creator: doc.getCreator() ?? '',
          producer: doc.getProducer() ?? '',
        });
        setCreationDate(doc.getCreationDate() ?? null);
      } catch {
        if (genRef.current !== gen) return;
        setForm(EMPTY_FORM);
        setCreationDate(null);
        setLoadErrorKey('metadata.error_load');
      }
    })();
  }, [src]);

  const setField = (key: keyof MetadataForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async (dest: 'download' | 'pick' = 'download') => {
    setRunError(null);
    if (!src) {
      setRunError({ key: 'metadata.error_no_file' });
      return;
    }
    setBusy(true);
    try {
      setProgress({ value: 20, label: t('metadata.progress_saving') });
      const doc = await PDFDocument.load(src.bytes.slice());
      doc.setTitle(form.title);
      doc.setAuthor(form.author);
      doc.setSubject(form.subject);
      doc.setKeywords(form.keywords.split(',').map((s) => s.trim()));
      doc.setCreator(form.creator);
      doc.setProducer(form.producer);
      // Preserve the original CreationDate (acceptance: save must not shift it).
      if (creationDate) doc.setCreationDate(creationDate);
      const out = await doc.save();
      if (await deliverBytes(out, outputName(src.file.name), dest)) {
        setProgress({ value: 100, label: t('metadata.progress_done') });
      } else {
        setProgress(null); // picker cancelled — not an error
      }
    } catch (e) {
      setRunError({
        key: 'metadata.error_save',
        values: { message: e instanceof Error ? e.message : String(e) },
      });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const resetAll = () => {
    clear();
    setForm(EMPTY_FORM);
    setCreationDate(null);
    setProgress(null);
    setRunError(null);
    setLoadErrorKey(null);
  };

  const fileErrorParts = (() => {
    if (!fileError) return null;
    const idx = fileError.indexOf(':');
    const code = idx === -1 ? fileError : fileError.slice(0, idx);
    const name = idx === -1 ? '' : fileError.slice(idx + 1);
    if (code === 'too-large') return { key: 'metadata.err_too_large', values: { name } };
    if (code === 'not-pdf') return { key: 'metadata.err_not_pdf', values: { name } };
    if (code === 'heic-refused') return { key: 'metadata.err_heic', values: { name } };
    return null;
  })();

  const error = fileErrorParts
    ? t(fileErrorParts.key, fileErrorParts.values)
    : runError
      ? t(runError.key, runError.values)
      : loadErrorKey
        ? t(loadErrorKey)
        : null;

  return (
    <WorkspaceShell
      title={t('metadata.title')}
      meta={
        src
          ? lng === 'vi'
            ? `${src.file.name} · ${formatBytes(src.file.size, 'vi-VN')}`
            : `${src.file.name} · ${formatBytes(src.file.size, 'en-US')}`
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: src ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: src && !loadErrorKey ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      error={error}
      side={
        <>
          <Button onClick={() => void save()} disabled={!src || busy || loadErrorKey !== null}>
            {t('metadata.cta')}
          </Button>
          {canSaveElsewhere() ? (
            <Button
              variant="secondary"
              disabled={!src || busy || loadErrorKey !== null}
              onClick={() => void save('pick')}
            >
              {t('save_elsewhere')}
            </Button>
          ) : null}
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('metadata.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <Dropzone
        title={t('metadata.dropzone_title')}
        hint={t('metadata.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          if (f.length === 0) return;
          clear();
          void add([f[0]]);
        }}
      />
      {src ? (
        <>
          {/*
            XSS note: file name and every metadata value below render as React
            text nodes / input values only. No raw-HTML rendering APIs are used
            anywhere in this file.
          */}
          <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]">
            <span aria-hidden className="text-text-muted"><FileIcon size={17} /></span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{src.file.name}</span>
            <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
              {formatBytes(src.file.size, locale)}
            </span>
          </div>
          <fieldset className="mt-4 flex flex-col gap-3" disabled={busy || loadErrorKey !== null}>
            {FIELDS.map(({ key, labelKey }) => (
              <label key={key} className="flex flex-col gap-1.5 text-[13.5px]">
                <span className="font-semibold text-text-primary">{t(labelKey)}</span>
                <Input
                  value={form[key]}
                  onChange={(e) => setField(key, e.target.value)}
                  aria-label={t(labelKey) as string}
                />
              </label>
            ))}
            <div className="flex flex-col gap-1.5 text-[13.5px]">
              <span className="font-semibold text-text-primary">{t('metadata.field_created')}</span>
              <span className="rounded-lg border border-border-default bg-surface-page px-3.5 py-2.5 text-sm text-text-primary tabular-nums">
                {creationDate ? creationDate.toLocaleString(locale) : t('metadata.empty_value')}
              </span>
            </div>
          </fieldset>
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
