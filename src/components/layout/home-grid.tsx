import { useTranslation } from 'react-i18next';
import { TOOLS, ToolCard, type ToolCategory } from './tool-card';
import { useMemo, useRef, useState } from 'react';
import { searchTools, type ToolSearchDoc } from '../../lib/tool-search';

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
  // Search docs MUST come from the tools namespace: bare t('tools.*') on the
  // common translator renders raw keys (the v0.8.1 raw-key class).
  const [query, setQuery] = useState('');
  const { t: tTools } = useTranslation('tools');
  const inputRef = useRef<HTMLInputElement>(null);

  // VI/EN task synonyms per tool (accent-folded at match time).
  const SYNONYMS: Record<string, string[]> = {
    merge: ['gop', 'noi', 'kết hợp', 'combine', 'join'],
    split: ['tach', 'chia', 'chia nhỏ', 'divide'],
    extract: ['trích', 'trich', 'lấy trang', 'pick pages'],
    remove: ['xóa trang', 'xoa trang', 'loại bỏ', 'delete pages'],
    reorder: ['đảo trang', 'dao trang', 'thứ tự', 'sort pages'],
    rotate: ['xoay', 'quay', 'nghiêng', 'turn'],
    'fill-form': ['điền form', 'dien form', 'điền biểu mẫu', 'fill fields'],
    ocr: ['quét chữ', 'quet chu', 'nhận dạng', 'văn bản quét', 'recognize', 'scan text'],
    compress: ['nén', 'nen', 'giảm dung lượng', 'nhỏ hơn', 'shrink', 'reduce size'],
    'pdf-to-img': ['ảnh', 'anh', 'jpg', 'png', 'convert image', 'xuất ảnh'],
    'img-to-pdf': ['ảnh sang pdf', 'anh sang pdf', 'ghép ảnh', 'image to pdf'],
    encrypt: ['mật khẩu', 'mat khau', 'khóa file', 'protect', 'password'],
    metadata: ['thuộc tính', 'thong tin', 'tiêu đề', 'properties', 'author'],
    sign: ['ký số', 'ky so', 'chữ ký', 'chu ky', 'certificate'],
    watermark: ['đóng dấu', 'dong dau', 'tem', 'logo mờ'],
    'page-numbers': ['đánh số', 'danh so', 'số trang', 'numbering'],
    editor: ['xóa dữ liệu', 'xoa du lieu', 'redact', 'che thông tin', 'sensitive'],
    'pdf-to-word': ['word', 'docx', 'chuyển word', 'sửa được'],
    compare: ['so sánh', 'so sanh', 'diff', 'khác biệt', 'changes'],
    'blank-pages': ['trang trắng', 'trang trang', 'xóa trắng', 'empty pages'],
    organize: ['sắp xếp', 'sap xep', 'tổ chức', 'to chuc', 'dấu trang', 'bookmarks', 'arrange'],
    tables: ['bảng', 'bang', 'excel', 'csv', 'xlsx', 'trích bảng'],
    diagnostics: ['chẩn đoán', 'chan doan', 'kiểm tra file', 'sửa file', 'repair', 'kiểm tra lỗi pdf', 'sửa lỗi'],
    'scan-cleanup': ['làm sạch', 'lam sach', 'deskew', 'làm nét', 'nét scan'],
  };

  const docs: ToolSearchDoc[] = useMemo(
    () =>
      TOOLS.map((tool) => ({
        slug: tool.slug,
        name: tTools(tool.slug + '.title'),
        desc: tTools(tool.slug + '.desc'),
        category: tool.category,
        aliases: SYNONYMS[tool.slug] ?? [],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );
  const hits = useMemo(
    () => searchTools(docs, query, filter === 'all' ? undefined : [filter]),
    [docs, query, filter],
  );

  const groups: { key: ToolCategory; label: string }[] = [
    { key: 'org', label: t('filters.organize') },
    { key: 'opt', label: t('filters.optimize') },
    { key: 'sec', label: t('filters.secure') },
  ];

  return (
    <div>
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
      <div className="relative mt-1">
        <input
          ref={inputRef}
          type="search"
          value={query}
          data-testid="tool-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              (document.querySelector('#toolGroups a, #toolGroups button') as HTMLElement | null)?.focus();
            }
          }}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          className="min-h-11 w-full rounded-xl border border-border-strong bg-surface-card px-4 text-[14px] text-text-primary outline-none focus:border-accent"
        />
      </div>
      <div id="toolGroups">
        {query.trim() !== '' && hits.length === 0 ? (
          <p className="mt-8 text-center text-[14px] text-text-muted" data-testid="tool-search-empty">
            {t('search.no_results', { q: query })}
          </p>
        ) : query.trim() !== '' ? (
          <section aria-label={t('search.placeholder')}>
            <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {hits
                .map((h) => TOOLS.find((tool) => tool.slug === h.slug))
                .filter((tool): tool is (typeof TOOLS)[number] => Boolean(tool))
                .map((tool) => (
                  <ToolCard key={tool.slug} tool={tool} />
                ))}
            </div>
          </section>
        ) : (
        groups.map(
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
            )
        ))}
      </div>
    </div>
  );
}

// token-mapped
