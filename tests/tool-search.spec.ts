import { describe, expect, it } from 'vitest';

import { foldText, searchTools, type ToolSearchDoc } from '../src/lib/tool-search';

/*
 * Phase-7 search suite: accent-folding, synonyms, deterministic ranking,
 * category combination.
 */

const doc = (slug: string, name: string, desc: string, category = 'org', aliases?: string[]): ToolSearchDoc => ({
  slug,
  name,
  desc,
  category,
  aliases,
});

const DOCS: ToolSearchDoc[] = [
  doc('merge', 'Gộp PDF', 'Ghép nhiều file PDF thành một', 'org', ['gop', 'noi', 'combine', 'join']),
  doc('compress', 'Nén PDF', 'Giảm dung lượng file PDF', 'opt', ['nen', 'reduce', 'shrink']),
  doc('sign', 'Ký số PDF', 'Ký PDF bằng chứng chỉ số', 'sec', ['ky so', 'chu ky', 'certificate']),
  doc('tables', 'Trích xuất bảng', 'Nhận diện bảng, xuất CSV/XLSX', 'org', ['bang', 'excel', 'csv']),
];

describe('foldText', () => {
  it('strips Vietnamese diacritics + folds đ', () => {
    expect(foldText('Gộp Nguyễn Đổng')).toBe('gop nguyen dong');
  });
});

describe('searchTools ranking (deterministic)', () => {
  it('exact > prefix > substring > alias > description', () => {
    const hits = searchTools(DOCS, 'gộp');
    expect(hits[0]!.slug).toBe('merge');
    expect(hits).toHaveLength(1);
  });

  it('accent-insensitive + diacritic-free query matches', () => {
    expect(searchTools(DOCS, 'gop')[0]!.slug).toBe('merge');
    expect(searchTools(DOCS, 'ky so')[0]!.slug).toBe('sign');
  });

  it('synonym hit ranks below name hits', () => {
    const hits = searchTools(DOCS, 'excel');
    expect(hits[0]!.slug).toBe('tables');
    const hitsJoin = searchTools(DOCS, 'join');
    expect(hitsJoin[0]!.slug).toBe('merge');
  });

  it('description-only matches still surface, ranked last', () => {
    const hits = searchTools(DOCS, 'dung lượng');
    expect(hits[0]!.slug).toBe('compress');
  });

  it('category combination filters first', () => {
    const hits = searchTools(DOCS, 'pdf', ['sec']);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.slug).toBe('sign');
  });

  it('no match -> empty (no-result state)', () => {
    expect(searchTools(DOCS, 'zzzzz')).toEqual([]);
  });

  it('word-AND across name+desc', () => {
    const hits = searchTools(DOCS, 'xuất bảng');
    expect(hits[0]!.slug).toBe('tables');
  });

  it('empty query lists all in registry order', () => {
    expect(searchTools(DOCS, '').map((h) => h.slug)).toEqual(['merge', 'compress', 'sign', 'tables']);
  });
});
