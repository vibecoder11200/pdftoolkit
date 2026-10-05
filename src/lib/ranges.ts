export function parseRanges(input: string, maxPage: number): { ranges: number[][]; error?: string } {
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ranges: [], error: 'empty' };
  const ranges: number[][] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return { ranges: [], error: `bad:${part}` };
    let a = Number(m[1]);
    let b = m[2] !== undefined ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > maxPage) return { ranges: [], error: `range:${part}` };
    const pages: number[] = [];
    for (let n = a; n <= b; n += 1) {
      if (seen.has(n)) return { ranges: [], error: `overlap:${n}` };
      seen.add(n);
      pages.push(n);
    }
    ranges.push(pages);
  }
  return { ranges };
}
