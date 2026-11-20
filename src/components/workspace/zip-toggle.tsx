import { useTranslation } from 'react-i18next';

/*
 * Shared ZIP-export checkbox (v0.13.0 phase 2) for multi-output tools
 * (split-separate, compare). `visible` follows the tool's run shape: the
 * toggle only exists when the run WILL produce more than one file — a
 * single-output run must never render it (dead-UI rule from the plan).
 */

export function ZipToggle({
  checked,
  onChange,
  visible,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  visible: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation(['common']);
  if (!visible) return null;
  return (
    <label
      data-testid="zip-toggle"
      className="flex cursor-pointer items-center gap-2 text-[13.5px] text-text-primary"
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-accent"
      />
      {t('zip.toggle_label')}
    </label>
  );
}

// token-mapped
