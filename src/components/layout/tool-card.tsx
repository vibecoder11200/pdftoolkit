import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export type ToolCategory = 'org' | 'opt' | 'sec';

export interface ToolDef {
  slug: string;
  icon: string;
  tone: string;
  category: ToolCategory;
  /** Accepts (and keeps) every dropped file; single-file tools take only the first. */
  multiFile?: boolean;
}

// Tones come from the --tone-* token set (src/theme/tokens.css) so tiles
// restyle with the theme instead of hardcoding light palette classes.
// A slug IS its route segment (routes.tsx) — locale keys follow suit.
export const TOOLS: ToolDef[] = [
  { slug: 'merge', icon: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2', tone: 'bg-tone-red-soft text-tone-red', category: 'org', multiFile: true },
  { slug: 'split', icon: 'M8 3v18M3 8h5M3 16h5M16 8h5M16 16h5', tone: 'bg-tone-red-soft text-tone-red', category: 'org' },
  { slug: 'extract', icon: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 8h6M9 12h4', tone: 'bg-tone-orange-soft text-tone-orange', category: 'org' },
  { slug: 'remove', icon: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7', tone: 'bg-tone-orange-soft text-tone-orange', category: 'org' },
  { slug: 'reorder', icon: 'M7 4v13m0 0-3-3m3 3 3-3M17 20V7m0 0-3 3m3-3 3 3', tone: 'bg-tone-teal-soft text-tone-teal', category: 'org' },
  { slug: 'rotate', icon: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6', tone: 'bg-tone-teal-soft text-tone-teal', category: 'org' },
  { slug: 'fill-form', icon: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8.5 8h7M8.5 12h7M8.5 16h4.5', tone: 'bg-tone-teal-soft text-tone-teal', category: 'org' },
  { slug: 'ocr', icon: 'M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM14 3v6h6M8 13h8M8 17h5', tone: 'bg-tone-green-soft text-tone-green', category: 'opt' },
  { slug: 'compress', icon: 'M12 3v10m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2', tone: 'bg-tone-green-soft text-tone-green', category: 'opt' },
  { slug: 'pdf-to-img', icon: 'M3 5h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm3 4a1.6 1.6 0 1 0 0 .01M5 18l5-5 3 3 3-3 3 3', tone: 'bg-tone-blue-soft text-tone-blue', category: 'opt' },
  { slug: 'img-to-pdf', icon: 'M12 17V7m0 0-4 4m4-4 4 4M4 21h16', tone: 'bg-tone-blue-soft text-tone-blue', category: 'opt', multiFile: true },
  { slug: 'encrypt', icon: 'M4 10h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM8 10V7a4 4 0 0 1 8 0v3', tone: 'bg-tone-purple-soft text-tone-purple', category: 'sec' },
  { slug: 'metadata', icon: 'M4 20h16M6 16l2-9h8l2 9M10 7V5a2 2 0 0 1 4 0v2', tone: 'bg-tone-purple-soft text-tone-purple', category: 'sec' },
  { slug: 'sign', icon: 'm12 19 7-7a4.95 4.95 0 1 0-7-7l-7 7v7h7ZM14 8l2 2', tone: 'bg-tone-green-soft text-tone-green', category: 'sec' },
];

export function ToolCard({ tool }: { tool: ToolDef }) {
  const { t } = useTranslation('tools');
  return (
    <Link
      to={`/tools/${tool.slug}`}
      data-cat={tool.category}
      className="flex flex-col gap-1 rounded-2xl border border-border-default bg-surface-card p-4 pb-5 text-left transition hover:-translate-y-0.5 hover:border-accent"
    >
      <span className={`grid h-11 w-11 place-items-center rounded-xl ${tool.tone}`} aria-hidden>
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d={tool.icon} />
        </svg>
      </span>
      <h3 className="mt-2.5 text-[15px] font-bold">{t(`${tool.slug}.title`)}</h3>
      <p className="text-[13px] leading-relaxed text-text-muted">{t(`${tool.slug}.desc`)}</p>
    </Link>
  );
}

// token-mapped
