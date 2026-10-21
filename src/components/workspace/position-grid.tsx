import { useTranslation } from 'react-i18next';
import type { GridPos9 } from '../../engine/pdf-lib';

/*
 * Shared 3×3 anchor picker (v0.8.0). Extracted from watermark-tool when
 * page-numbers needed the same grid — the phase-2 "extract only when phase 3
 * proves the duplication" decision point, duplication proved. Position
 * values are the phase-1 GridPos9 contract; `import type` keeps pdf-lib out
 * of the UI graph (only the type crosses, never the module).
 */

const GRID_POSITIONS: GridPos9[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export function PositionGrid({
  value,
  onChange,
  label,
}: {
  value: GridPos9;
  onChange: (pos: GridPos9) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={label} className="mt-2 grid w-28 grid-cols-3 gap-1">
      {GRID_POSITIONS.map((pos) => (
        <button
          key={pos}
          type="button"
          role="radio"
          aria-checked={value === pos}
          aria-label={t('grid_pos.' + pos.replace('-', '_'))}
          title={t('grid_pos.' + pos.replace('-', '_'))}
          onClick={() => onChange(pos)}
          className={`h-7 w-7 rounded border-2 transition ${
            value === pos
              ? 'border-accent bg-accent-soft'
              : 'border-border-strong bg-surface-card hover:border-accent'
          }`}
        />
      ))}
    </div>
  );
}

// token-mapped
