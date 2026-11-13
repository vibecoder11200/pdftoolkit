/*
 * Phase-7 tool search (plan 261112-0955): accent-insensitive VI/EN
 * matching over localized names/descriptions + task synonyms. NO network
 * embeddings, NO model download — pure metadata scoring. Deterministic
 * ranking: exact-prefix > name-substring > synonym > description; ties
 * break by registry order. Category combination filters first.
 */

export interface ToolSearchDoc {
  slug: string;
  /** Localized display name (already translated). */
  name: string;
  /** Localized one-line description. */
  desc: string;
  category: string;
  /** Task synonyms (VI/EN), e.g. 'gộp', 'hop', 'merge', 'join'. */
  aliases?: string[];
}

export interface ToolSearchHit {
  slug: string;
  score: number;
}

/** NFD + strip combining marks + lowercase (accent-insensitive VI/EN). */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

export function searchTools(
  docs: ToolSearchDoc[],
  query: string,
  activeCategories: string[] = [],
): ToolSearchHit[] {
  const q = foldText(query.trim());
  if (q.length === 0) {
    return docs
      .filter((d) => activeCategories.length === 0 || activeCategories.includes(d.category))
      .map((d) => ({ slug: d.slug, score: 0 }));
  }
  const hits: ToolSearchHit[] = [];
  for (const [i, doc] of docs.entries()) {
    if (activeCategories.length > 0 && !activeCategories.includes(doc.category)) continue;
    const name = foldText(doc.name);
    const desc = foldText(doc.desc);
    const aliases = (doc.aliases ?? []).map(foldText);
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 90;
    else if (name.includes(q)) score = 70;
    else if (aliases.some((a) => a === q || a.startsWith(q))) score = 55;
    else if (aliases.some((a) => a.includes(q))) score = 45;
    else if (desc.includes(q)) score = 25;
    else {
      // all query WORDS present across name+desc+aliases (word-AND)
      const words = q.split(/\s+/).filter(Boolean);
      const haystack = [name, desc, ...aliases].join(' ');
      if (words.length > 1 && words.every((w) => haystack.includes(w))) score = 15;
    }
    if (score > 0) hits.push({ slug: doc.slug, score: score * 1000 + (1000 - i) });
  }
  return hits.sort((a, b) => b.score - a.score);
}
