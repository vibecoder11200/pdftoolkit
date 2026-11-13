import { PDFDocument, PDFDict, PDFArray, PDFName, PDFNumber, PDFString, PDFHexString } from 'pdf-lib';

/*
 * Phase-4 bookmark core (plan 261112-0955 phase 4). Read: explicit and
 * named LOCAL destinations from the /Outlines tree; hostile structures
 * (cycles, over-deep/over-wide trees) rejected; external GoToR/URI/Launch/
 * JS actions are INERT (kept as titles only, never executed). Write: the
 * composer materializes /Outlines with remapped explicit destinations.
 * JSON import/export is a versioned UI interchange format — imported JSON
 * can NEVER carry executable actions (no URI/JS/Launch fields survive).
 */

export const BOOKMARK_MAX_DEPTH = 32;
export const BOOKMARK_MAX_NODES = 10_000;

export interface BookmarkView {
  kind: 'fit' | 'xyz';
  x?: number;
  y?: number;
  zoom?: number;
}

/** Raw (parse-level) destination bound to a SOURCE page number. */
export interface BookmarkDest {
  /** 1-based page in the document the outline belongs to. */
  page: number;
  view: BookmarkView;
}

/** A node whose destination could not be resolved (target deleted/external). */
export interface UnresolvedBookmark {
  id: string;
  title: string;
  reason: 'target-page-out-of-range' | 'named-dest-missing' | 'external-action' | 'malformed-dest';
}

export interface BookmarkNode {
  id: string;
  title: string;
  dest: BookmarkDest | null;
  children: BookmarkNode[];
}

export interface ParseOutlinesResult {
  roots: BookmarkNode[];
  unresolved: UnresolvedBookmark[];
  namedDests: Map<string, BookmarkDest>;
  truncated: boolean;
}

export class BookmarkParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookmarkParseError';
  }
}

let nodeCounter = 0;
function nextNodeId(): string {
  nodeCounter += 1;
  return `bm${nodeCounter}`;
}

/** /Title bytes: UTF-16BE when BOM-marked, else PDFDocEncoding (latin-1
 * superset approximation - Unicode titles round-trip via the BOM path
 * most writers use). */
function decodeTitle(raw: PDFString | PDFHexString): string {
  return decodeTitleBytes(raw.asBytes());
}

function decodeTitleBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return out;
  }
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/* ------------------------------ parsing ----------------------------------- */

interface ParseCtx {
  doc: PDFDocument;
  context: import('pdf-lib').PDFContext;
  pageCount: number;
  namedDests: Map<string, BookmarkDest>;
  unresolved: UnresolvedBookmark[];
  /** Object-identity visited set (lookup caches per-ref instances). */
  visited: Set<PDFDict>;
  nodeCount: number;
  truncated: boolean;
}

/** Cast-lookup helper: unknown values (dict.get results, tree cursors)
 * ride through `as never`; pdf-lib's LookupKey union is narrower than the
 * values a hostile file produces. Returns the parsed PDFObject. */
function lk(ctx: ParseCtx, value: unknown): unknown {
  return ctx.context.lookup(value as never);
}

/** Parse explicit dest array [page /XYZ x y zoom] or [page /Fit]. */
function parseDestArray(ctx: ParseCtx, arr: PDFArray): BookmarkDest | null {
  const pageObj = lk(ctx, arr.get(0));
  let page = -1;
  if (pageObj instanceof PDFDict) {
    const pages = ctx.doc.getPages();
    for (let i = 0; i < pages.length; i += 1) {
      if (lk(ctx, pages[i]!.ref) === pageObj) {
        page = i + 1;
        break;
      }
    }
  } else if (pageObj instanceof PDFNumber) {
    page = pageObj.asNumber() + 1;
  }
  if (page < 1 || page > ctx.pageCount) return null;
  const mode = arr.get(1);
  const modeStr = mode instanceof PDFName ? mode.asString() : '';
  const num = (i: number): number | undefined => {
    const v = lk(ctx, arr.get(i));
    return v instanceof PDFNumber ? v.asNumber() : undefined;
  };
  if (modeStr === '/XYZ') {
    return { page, view: { kind: 'xyz', x: num(2), y: num(3), zoom: num(4) } };
  }
  return { page, view: { kind: 'fit' } };
}

/** Resolve a destination that may be a named string; misses land in
 * unresolved. */
function parseDest(ctx: ParseCtx, value: unknown, nodeId: string, title: string): BookmarkDest | null {
  const obj = lk(ctx, value);
  if (obj instanceof PDFArray) return parseDestArray(ctx, obj);
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    const named = ctx.namedDests.get(decodeTitle(obj));
    if (named) return named;
    ctx.unresolved.push({ id: nodeId, title, reason: 'named-dest-missing' });
    return null;
  }
  return null;
}

function refKey(ctx: ParseCtx, value: unknown): PDFDict | null {
  const dict = lk(ctx, value);
  return dict instanceof PDFDict ? dict : null;
}

/** Walk one outline item; bounded depth, cycle-safe sibling chain. */
function walkItem(ctx: ParseCtx, itemRef: unknown, depth: number): BookmarkNode | null {
  if (depth > BOOKMARK_MAX_DEPTH) {
    ctx.truncated = true;
    return null;
  }
  const dict = lk(ctx, itemRef);
  if (!(dict instanceof PDFDict)) return null;
  if (ctx.visited.has(dict)) return null; // cyclic structure
  ctx.visited.add(dict);
  ctx.nodeCount += 1;
  if (ctx.nodeCount > BOOKMARK_MAX_NODES) {
    ctx.truncated = true;
    return null;
  }
  const id = nextNodeId();
  const titleRaw = dict.get(PDFName.of('Title'));
  const title =
    titleRaw instanceof PDFString || titleRaw instanceof PDFHexString ? decodeTitle(titleRaw) : '';
  let dest: BookmarkDest | null = null;
  const destRaw = dict.get(PDFName.of('Dest'));
  if (destRaw !== undefined) {
    dest = parseDest(ctx, destRaw, id, title);
  } else {
    const action = lk(ctx, dict.get(PDFName.of('A')));
    if (action instanceof PDFDict) {
      const s = action.get(PDFName.of('S'));
      const sStr = s instanceof PDFName ? s.asString() : '';
      if (sStr === '/GoTo') {
        dest = parseDest(ctx, action.get(PDFName.of('D')), id, title);
      } else if (sStr !== '') {
        ctx.unresolved.push({ id, title, reason: 'external-action' });
      }
    }
  }
  const children: BookmarkNode[] = [];
  if (dict.has(PDFName.of('First'))) {
    let cursor: unknown = dict.get(PDFName.of('First'));
    const seenSiblings = new Set<PDFDict>();
    while (cursor !== undefined) {
      const curKey = refKey(ctx, cursor);
      if (!curKey || seenSiblings.has(curKey)) break; // cyclic siblings
      seenSiblings.add(curKey);
      const child = walkItem(ctx, cursor, depth + 1);
      if (child) children.push(child);
      const next = lk(ctx, cursor);
      if (next instanceof PDFDict && next.has(PDFName.of('Next'))) {
        cursor = next.get(PDFName.of('Next'));
      } else {
        break;
      }
    }
  }
  return { id, title, dest, children };
}

function parseDestArrayOrNull(ctx: ParseCtx, value: unknown): BookmarkDest | null {
  const obj = lk(ctx, value);
  if (obj instanceof PDFArray) return parseDestArray(ctx, obj);
  return null;
}

/** Named destinations: /Names -> /Dests name tree (kids/names arrays) or
 * the PDF 1.1 /Dests dictionary. */
function parseNamedDests(ctx: ParseCtx): void {
  const catalog = ctx.doc.catalog;
  const namesRoot = lk(ctx, catalog.get(PDFName.of('Names')));
  if (namesRoot instanceof PDFDict) {
    const destsTree = lk(ctx, namesRoot.get(PDFName.of('Dests')));
    if (destsTree instanceof PDFDict) {
      const walkTree = (node: unknown, depth: number): void => {
        if (depth > BOOKMARK_MAX_DEPTH) return;
        const d = lk(ctx, node);
        if (!(d instanceof PDFDict)) return;
        const namesArr = lk(ctx, d.get(PDFName.of('Names')));
        if (namesArr instanceof PDFArray) {
          for (let i = 0; i + 1 < namesArr.size(); i += 2) {
            const nameObj = lk(ctx, namesArr.get(i));
            const name =
              nameObj instanceof PDFString || nameObj instanceof PDFHexString
                ? decodeTitle(nameObj)
                : '';
            if (name && !ctx.namedDests.has(name)) {
              const parsed = parseDestArrayOrNull(ctx, namesArr.get(i + 1));
              if (parsed) ctx.namedDests.set(name, parsed);
            }
          }
        }
        const kids = lk(ctx, d.get(PDFName.of('Kids')));
        if (kids instanceof PDFArray) {
          for (let i = 0; i < kids.size(); i += 1) walkTree(kids.get(i), depth + 1);
        }
      };
      walkTree(destsTree, 0);
    }
  }
  // PDF 1.1 dictionary form.
  const legacy = lk(ctx, catalog.get(PDFName.of('Dests')));
  if (legacy instanceof PDFDict) {
    for (const [k, v] of legacy.entries()) {
      const name = k instanceof PDFString ? decodeTitle(k) : k.asString();
      if (!ctx.namedDests.has(name)) {
        const parsed = parseDestArrayOrNull(ctx, v);
        if (parsed) ctx.namedDests.set(name, parsed);
      }
    }
  }
}

/** Parse the document's outline tree. Hostile SHAPES (cycles, over-deep,
 * over-wide) are bounded and flagged, never thrown; only unreadable PDFs
 * throw. */
export async function parseOutlines(bytes: Uint8Array): Promise<ParseOutlinesResult> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const ctx: ParseCtx = {
    doc,
    context: doc.context,
    pageCount: doc.getPageCount(),
    namedDests: new Map(),
    unresolved: [],
    visited: new Set<PDFDict>(),
    nodeCount: 0,
    truncated: false,
  };
  parseNamedDests(ctx);
  const outlines = lk(ctx, doc.catalog.get(PDFName.of('Outlines')));
  const roots: BookmarkNode[] = [];
  if (outlines instanceof PDFDict && outlines.has(PDFName.of('First'))) {
    let cursor: unknown = outlines.get(PDFName.of('First'));
    const seenSiblings = new Set<PDFDict>();
    while (cursor !== undefined) {
      const curKey = refKey(ctx, cursor);
      if (!curKey || seenSiblings.has(curKey)) break;
      seenSiblings.add(curKey);
      const node = walkItem(ctx, cursor, 0);
      if (node) roots.push(node);
      const next = lk(ctx, cursor);
      if (next instanceof PDFDict && next.has(PDFName.of('Next'))) {
        cursor = next.get(PDFName.of('Next'));
      } else {
        break;
      }
    }
  }
  return { roots, unresolved: ctx.unresolved, namedDests: ctx.namedDests, truncated: ctx.truncated };
}

/* --------------------------- UI interchange ------------------------------- */

const BOOKMARK_JSON_VERSION = 1;

/** Versioned UI interchange. Hostile input is rejected structurally; NO
 * action/URI/JS field exists in the format, so imported JSON can never
 * smuggle executable behavior (external actions are inert by shape). */
export function bookmarksToJson(
  roots: Array<Pick<BookmarkNode, 'id' | 'title' | 'dest' | 'children'>>,
): string {
  const toj = (
    nodes: Array<Pick<BookmarkNode, 'id' | 'title' | 'dest' | 'children'>>,
  ): unknown[] =>
    nodes.map((n) => ({
      id: n.id,
      title: n.title,
      dest: n.dest ? { page: n.dest.page, view: n.dest.view } : null,
      children: toj(n.children),
    }));
  return JSON.stringify({ version: BOOKMARK_JSON_VERSION, roots: toj(roots) }, null, 2);
}

export function bookmarksFromJson(raw: string): { roots: BookmarkNode[]; rejected: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BookmarkParseError('invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BookmarkParseError('invalid shape');
  }
  const obj = parsed as { version?: unknown; roots?: unknown };
  if (obj.version !== BOOKMARK_JSON_VERSION) {
    throw new BookmarkParseError(`unsupported version: ${String(obj.version)}`);
  }
  if (!Array.isArray(obj.roots)) throw new BookmarkParseError('roots must be an array');
  let rejected = 0;
  let count = 0;
  const conv = (nodes: unknown[], depth: number): BookmarkNode[] => {
    if (depth > BOOKMARK_MAX_DEPTH) {
      rejected += nodes.length;
      return [];
    }
    const out: BookmarkNode[] = [];
    for (const n of nodes) {
      count += 1;
      if (count > BOOKMARK_MAX_NODES) {
        rejected += 1;
        continue;
      }
      if (typeof n !== 'object' || n === null) {
        rejected += 1;
        continue;
      }
      const o = n as { title?: unknown; dest?: unknown; children?: unknown };
      const title = typeof o.title === 'string' ? o.title.slice(0, 500) : '';
      let dest: BookmarkDest | null = null;
      if (typeof o.dest === 'object' && o.dest !== null) {
        const d = o.dest as { page?: unknown; view?: unknown };
        const page = typeof d.page === 'number' ? Math.floor(d.page) : -1;
        if (page >= 1 && page <= 1_000_000) {
          const viewRaw = (typeof d.view === 'object' && d.view !== null ? d.view : {}) as {
            kind?: unknown;
            x?: unknown;
            y?: unknown;
            zoom?: unknown;
          };
          const view: BookmarkView = {
            kind: viewRaw.kind === 'xyz' ? 'xyz' : 'fit',
            x: typeof viewRaw.x === 'number' ? viewRaw.x : undefined,
            y: typeof viewRaw.y === 'number' ? viewRaw.y : undefined,
            zoom: typeof viewRaw.zoom === 'number' ? viewRaw.zoom : undefined,
          };
          dest = { page, view };
        } else {
          rejected += 1;
        }
      }
      const children = Array.isArray(o.children) ? conv(o.children, depth + 1) : [];
      out.push({ id: nextNodeId(), title, dest, children });
    }
    return out;
  };
  const roots = conv(obj.roots, 0);
  return { roots, rejected };
}
