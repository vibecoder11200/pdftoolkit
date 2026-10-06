import { useTranslation } from 'react-i18next';
import { TOOLS, ToolCard, type ToolCategory } from './tool-card';

type Filter = 'all' | ToolCategory;

const FILTERS: Filter[] = ['all', 'org', 'opt', 'sec'];

// Category codes ('org'...) differ from locale keys ('organize'...).
const FILTER_LABEL: Record<Filter, string> = {
  all: 'filters.all',
  org: 'filters.organize',
  opt: 'filters.optimize',
  sec: 'filters.secure',
};

export function HomeGrid({ filter, onFilter }: { filter: Filter; onFilter: (f: Filter) => void }) {
  const { t } = useTranslation();
  const groups: { key: ToolCategory; label: string }[] = [
    { key: 'org', label: t('filters.organize') },
    { key: 'opt', label: t('filters.optimize') },
    { key: 'sec', label: t('filters.secure') },
  ];

  return (
    <div data-tour="tool-grid">
      <div className="sticky top-13 z-20 flex flex-wrap gap-2.5 bg-surface-page/90 py-4 backdrop-blur" role="group" aria-label={t('filters.all')}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            data-cat={f}
            onClick={() => onFilter(f)}
            className={`min-h-10 rounded-full border px-4.5 py-2 text-[13.5px] font-semibold ${
              filter === f
                ? 'border-surface-inverse bg-surface-inverse text-text-inverse'
                : 'border-border-strong bg-surface-card text-text-muted hover:border-accent hover:text-text-primary'
            }`}
          >
            {t(FILTER_LABEL[f])}
          </button>
        ))}
      </div>
      <div id="toolGroups">
        {groups.map(
          (g) =>
            (filter === 'all' || filter === g.key) && (
              <section key={g.key} aria-label={g.label}>
                <h2 className="mt-7.5 mb-3 text-xs font-bold tracking-[0.08em] text-text-muted uppercase" data-group={g.key}>
                  {g.label}
                </h2>
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                  {TOOLS.filter((tool) => tool.category === g.key).map((tool) => (
                    <ToolCard key={tool.slug} tool={tool} />
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
    </div>
  );
}

// token-mapped
