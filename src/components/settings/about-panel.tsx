import { useTranslation } from 'react-i18next';

const REPO_URL = 'https://github.com/vibecoder11200/pdftoolkit';

/** Credits must stay in sync with NOTICE.md (phase 7). */
const CREDITS: ReadonlyArray<{ name: string; license: string; url: string }> = [
  { name: 'transformers.js', license: 'Apache-2.0', url: 'https://github.com/huggingface/transformers.js' },
  { name: 'ONNX Runtime Web', license: 'MIT', url: 'https://github.com/microsoft/onnxruntime' },
  { name: 'Tesseract OCR', license: 'Apache-2.0', url: 'https://github.com/tesseract-ocr/tesseract' },
  { name: 'GLM-OCR (model)', license: 'MIT', url: 'https://huggingface.co/onnx-community/GLM-OCR-ONNX' },
];

export function AboutPanel() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="settings-about" className="mt-10 mb-4">
      <h2 id="settings-about" className="text-lg font-bold">
        {t('settings.about_title')}
      </h2>
      <div className="mt-3 rounded-xl border border-border-strong px-4 py-3 text-sm" data-testid="settings-about">
        <p data-testid="settings-version">
          PDF Toolkit v{__APP_VERSION__} · {__COMMIT_HASH__} ·{' '}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-text-primary">
            GitHub
          </a>{' '}
          · MIT
        </p>
        <p className="mt-2 font-semibold">{t('settings.credits_title')}</p>
        <ul className="mt-1 list-inside list-disc text-xs text-text-muted">
          {CREDITS.map((c) => (
            <li key={c.name}>
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-text-primary">
                {c.name}
              </a>{' '}
              ({c.license})
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
