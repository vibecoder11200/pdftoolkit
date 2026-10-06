import { useTranslation } from 'react-i18next';

/** Token spinner + label with aria-busy. Motion respects prefers-reduced-motion
 * via the global CSS rule (the spinner simply stops animating there). */
export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5 py-6 text-[13.5px] text-text-muted" role="status" aria-busy="true">
      <span
        className="h-4.5 w-4.5 animate-spin rounded-full border-2 border-border-strong border-t-accent"
        aria-hidden
      />
      {label ?? t('a11y.loading')}
    </div>
  );
}
