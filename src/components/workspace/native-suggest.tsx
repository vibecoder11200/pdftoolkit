import { useTranslation } from 'react-i18next';
import { useNativeSuggestVisible } from '../../hooks/use-native-suggest';
import { dismissNativeSuggest } from '../../lib/native-suggest';
import { isTauri } from '../../lib/platform';

/*
 * Smart-suggestion card (v0.6.0 phase 5, R5.1/D3): suggests the native
 * engine only where the in-app engine measured weak/CPU — never on web
 * (double-gated: this component checks isTauri AND the visibility hook),
 * never when already installed, dismissable per app release.
 */
export function NativeSuggestCard({ onUse }: { onUse: () => void }) {
  const { t } = useTranslation();
  const visible = useNativeSuggestVisible();
  if (!visible || !isTauri()) return null;
  return (
    <div
      data-testid="native-suggest-card"
      className="grid gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3.5 py-3 text-sm"
      role="note"
    >
      <p className="font-semibold">{t('ocr.native_suggest_title')}</p>
      <p className="text-xs text-text-muted">{t('ocr.native_suggest_body')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="native-suggest-use"
          className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
          onClick={onUse}
        >
          {t('ocr.native_suggest_cta')}
        </button>
        <button
          type="button"
          data-testid="native-suggest-dismiss"
          className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
          onClick={dismissNativeSuggest}
        >
          {t('ocr.native_suggest_dismiss')}
        </button>
      </div>
    </div>
  );
}
