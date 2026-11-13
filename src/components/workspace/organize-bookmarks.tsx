import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  bookmarksFromJson,
  bookmarksToJson,
  type BookmarkNode,
} from '../../lib/bookmarks';
import type { PageInstance } from '../../lib/organize-model';

/*
 * Phase-4 bookmark panel: stable-id tree bound to page INSTANCE ids, with
 * add/delete/rename/nest/reorder, target picker, undo/redo, and versioned
 * JSON import/export. Imported JSON is structurally rejected (no action
 * fields exist in the interchange format — nothing executable to run).
 */

export interface OrganizeBookmarkUiNode {
  id: string;
  title: string;
  /** The page INSTANCE this bookmark targets (manifest-stable). */
  targetInstanceId: string | null;
  children: OrganizeBookmarkUiNode[];
}

let bmCounter = 0;
const nextUiId = () => {
  bmCounter += 1;
  return `ui${bmCounter}`;
};

const toUi = (nodes: BookmarkNode[], pageToInstance: Map<number, string>): OrganizeBookmarkUiNode[] =>
  nodes.map((n) => ({
    id: nextUiId(),
    title: n.title,
    targetInstanceId: n.dest ? (pageToInstance.get(n.dest.page) ?? null) : null,
    children: toUi(n.children, pageToInstance),
  }));

export function OrganizeBookmarksPanel({
  instances,
  bookmarks,
  setBookmarks,
  past,
  setPast,
  future,
  setFuture,
  onNavigate,
}: {
  instances: PageInstance[];
  bookmarks: OrganizeBookmarkUiNode[];
  setBookmarks: React.Dispatch<React.SetStateAction<OrganizeBookmarkUiNode[]>>;
  past: OrganizeBookmarkUiNode[][];
  setPast: React.Dispatch<React.SetStateAction<OrganizeBookmarkUiNode[][]>>;
  future: OrganizeBookmarkUiNode[][];
  setFuture: React.Dispatch<React.SetStateAction<OrganizeBookmarkUiNode[][]>>;
  /** Preview navigation: select + scroll to the target tile. */
  onNavigate?: (instanceId: string) => void;
}) {
  const { t } = useTranslation('common');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mutate = (fn: (tree: OrganizeBookmarkUiNode[]) => OrganizeBookmarkUiNode[]) => {
    setPast((p) => [...p, bookmarks].slice(-100));
    setFuture([]);
    setBookmarks(fn(bookmarks));
  };

  const undoBm = () => {
    if (past.length === 0) return;
    setFuture((f) => [bookmarks, ...f]);
    setPast((p) => p.slice(0, -1));
    setBookmarks(past[past.length - 1]!);
  };
  const redoBm = () => {
    if (future.length === 0) return;
    setPast((p) => [...p, bookmarks]);
    setFuture((f) => f.slice(1));
    setBookmarks(future[0]!);
  };

  const findSelected = (tree: OrganizeBookmarkUiNode[]): OrganizeBookmarkUiNode | null => {
    if (!selectedId) return null;
    const stack = [...tree];
    while (stack.length > 0) {
      const n = stack.shift()!;
      if (n.id === selectedId) return n;
      stack.unshift(...n.children);
    }
    return null;
  };

  const addSiblingOrRoot = () => {
    const selNode = findSelected(bookmarks);
    const title = t('bookmarks.new_title');
    const node: OrganizeBookmarkUiNode = {
      id: nextUiId(),
      title,
      targetInstanceId: null,
      children: [],
    };
    const insert = (tree: OrganizeBookmarkUiNode[]): OrganizeBookmarkUiNode[] => {
      if (!selNode) return [...tree, node];
      const out: OrganizeBookmarkUiNode[] = [];
      for (const n of tree) {
        out.push(n);
        const visit = (x: OrganizeBookmarkUiNode): OrganizeBookmarkUiNode => ({
          ...x,
          children: x.children.some((c) => c.id === selNode.id)
            ? [...x.children.flatMap((c) => (c.id === selNode.id ? [c, node] : [c]))]
            : x.children.map(visit),
        });
        out[out.length - 1] = visit(n);
      }
      return out;
    };
    mutate(insert);
    setSelectedId(node.id);
  };

  const remove = (id: string) =>
    mutate((tree) =>
      tree.flatMap((n) => (n.id === id ? [] : [{ ...n, children: removeKids(n.children, id) }])),
    );
  const removeKids = (kids: OrganizeBookmarkUiNode[], id: string): OrganizeBookmarkUiNode[] =>
    kids.flatMap((n) => (n.id === id ? [] : [{ ...n, children: removeKids(n.children, id) }]));

  const nest = (id: string, direction: 1 | -1) =>
    mutate((tree) => {
      const pull = (kids: OrganizeBookmarkUiNode[]): OrganizeBookmarkUiNode[] => {
        const out: OrganizeBookmarkUiNode[] = [];
        for (let i = 0; i < kids.length; i += 1) {
          const n = kids[i]!;
          if (n.id === id && direction === 1 && out.length > 0) {
            const prev = out[out.length - 1]!;
            out[out.length - 1] = { ...prev, children: [...prev.children, n] };
          } else if (direction === -1) {
            out.push({ ...n, children: pullUp(n) });
          } else {
            out.push({ ...n, children: pull(n.children) });
          }
        }
        return out;
      };
      const pullUp = (n: OrganizeBookmarkUiNode): OrganizeBookmarkUiNode[] => n.children;
      return pull(tree);
    });

  const moveUpDown = (id: string, delta: number) =>
    mutate((tree) => {
      const swap = (kids: OrganizeBookmarkUiNode[]): OrganizeBookmarkUiNode[] => {
        const i = kids.findIndex((n) => n.id === id);
        if (i >= 0) {
          const j = i + delta;
          if (j < 0 || j >= kids.length) return kids;
          const copy = [...kids];
          copy[i] = copy[j]!;
          copy[j] = kids[i]!;
          return copy;
        }
        return kids.map((n) => ({ ...n, children: swap(n.children) }));
      };
      return swap(tree);
    });

  const setTarget = (id: string, targetInstanceId: string | null) =>
    mutate((tree) => mapTree(tree, (n) => (n.id === id ? { ...n, targetInstanceId } : n)));

  const importJson = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void f.text().then((raw) => {
        try {
          const { roots } = bookmarksFromJson(raw);
          // Bind raw dest pages to CURRENT manifest instances by position.
          const pageToInstance = new Map<number, string>();
          instances.forEach((p, i) => pageToInstance.set(i + 1, p.instanceId));
          mutate(() => toUi(roots, pageToInstance));
        } catch {
          // invalid import: surfaced, never silently dropped
          window.alert(t('bookmarks.import_invalid'));
        }
      });
    };
    input.click();
  };

  const exportJson = () => {
    const toRaw = (nodes: OrganizeBookmarkUiNode[]): BookmarkNode[] =>
      nodes.map((n, i) => ({
        id: `exp${i}`,
        title: n.title,
        dest: n.targetInstanceId
          ? {
              page: instances.findIndex((p) => p.instanceId === n.targetInstanceId) + 1,
              view: { kind: 'fit' as const },
            }
          : null,
        children: toRaw(n.children),
      }));
    const blob = new Blob([bookmarksToJson(toRaw(bookmarks))], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bookmarks.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  const renderNode = (n: OrganizeBookmarkUiNode, depth: number): React.ReactNode => (
    <div key={n.id}>
      <div
        className={`flex items-center gap-1 rounded px-1 py-0.5 text-[13px] ${
          selectedId === n.id ? 'bg-accent-soft' : ''
        }`}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <button
          type="button"
          className="flex-1 truncate text-left text-text-primary"
          data-testid={`bm-node-${n.id}`}
          onClick={() => {
            setSelectedId(n.id);
            if (n.targetInstanceId) onNavigate?.(n.targetInstanceId);
          }}
          onDoubleClick={() => {
            setRenaming(n.id);
            setDraftTitle(n.title);
          }}
        >
          {renaming === n.id ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={() => {
                mutate((tree) => mapTree(tree, (x) => (x.id === n.id ? { ...x, title: draftTitle } : x)));
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-full rounded border border-border-strong bg-surface-card px-1"
            />
          ) : (
            <>
              {n.targetInstanceId
                ? `• ${n.title}`
                : `▸ ${n.title}`}
            </>
          )}
        </button>
        <select
          aria-label={t('bookmarks.target_pick')}
          value={n.targetInstanceId ?? ''}
          onChange={(e) => setTarget(n.id, e.target.value || null)}
          className="max-w-24 rounded border border-border-strong bg-surface-card px-1 text-[12px]"
        >
          <option value="">{t('bookmarks.no_target')}</option>
          {instances.map((p, i) => (
            <option key={p.instanceId} value={p.instanceId}>
              {i + 1}
            </option>
          ))}
        </select>
        <button type="button" aria-label={t('bookmarks.up')} onClick={() => moveUpDown(n.id, -1)} className="min-h-7 min-w-7">↑</button>
        <button type="button" aria-label={t('bookmarks.down')} onClick={() => moveUpDown(n.id, 1)} className="min-h-7 min-w-7">↓</button>
        <button type="button" aria-label={t('bookmarks.nest')} onClick={() => nest(n.id, 1)} className="min-h-7 min-w-7">⇥</button>
        <button type="button" aria-label={t('bookmarks.unnest')} onClick={() => nest(n.id, -1)} className="min-h-7 min-w-7">⇤</button>
        <button type="button" aria-label={t('bookmarks.delete')} onClick={() => remove(n.id)} className="min-h-7 min-w-7 text-danger">✕</button>
      </div>
      {n.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div className="rounded-lg border border-border-strong bg-surface-card p-3" data-testid="bookmarks-panel">
      <p className="mb-2 text-[13.5px] font-semibold text-text-primary">{t('bookmarks.title')}</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <button type="button" data-testid="bm-add" onClick={addSiblingOrRoot} className="min-h-8 rounded border border-border-strong px-2 text-[12.5px]">{t('bookmarks.add')}</button>
        <button type="button" onClick={undoBm} disabled={past.length === 0} className="min-h-8 rounded border border-border-strong px-2 text-[12.5px] disabled:opacity-40">{t('organize.undo')}</button>
        <button type="button" onClick={redoBm} disabled={future.length === 0} className="min-h-8 rounded border border-border-strong px-2 text-[12.5px] disabled:opacity-40">{t('organize.redo')}</button>
        <button type="button" onClick={importJson} className="min-h-8 rounded border border-border-strong px-2 text-[12.5px]">{t('bookmarks.import')}</button>
        <button type="button" onClick={exportJson} className="min-h-8 rounded border border-border-strong px-2 text-[12.5px]">{t('bookmarks.export')}</button>
      </div>
      {bookmarks.length === 0 ? (
        <p className="text-[13px] text-text-muted">{t('bookmarks.empty')}</p>
      ) : (
        <div className="max-h-72 overflow-auto">{bookmarks.map((n) => renderNode(n, 0))}</div>
      )}
    </div>
  );
}

function mapTree(
  nodes: OrganizeBookmarkUiNode[],
  fn: (n: OrganizeBookmarkUiNode) => OrganizeBookmarkUiNode,
): OrganizeBookmarkUiNode[] {
  return nodes.map((n) => fn({ ...n, children: mapTree(n.children, fn) }));
}
