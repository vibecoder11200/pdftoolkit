/*
 * Phase-4 organizer model (plan 261112-0955 phase 4). The manifest is a
 * list of PAGE INSTANCES — stable ids bound to (sourceId, sourcePage) or a
 * blank spec — never PDF snapshots. Commands are metadata patches; the
 * engine composer materializes ONE output PDF from sources + manifest at
 * export time. Instance identity is the contract everything else leans on:
 * thumbnails, selections, bookmark targets and history inversions all
 * reference instanceIds, so a duplicate of the same source page is an
 * independent page (its own rotation), and thumbnail `pageNumber` display
 * position never masquerades as identity (thumbnail-strip assumption fix).
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface BlankSpec {
  widthPt: number;
  heightPt: number;
}

export interface PageInstance {
  /** Stable across the whole session; never reused after delete. */
  instanceId: string;
  /** null = blank page. */
  sourceId: string | null;
  /** 1-based page in the source; null for blanks. */
  sourcePage: number | null;
  blank: BlankSpec | null;
  /** Absolute displayed rotation. */
  rotation: Rotation;
}

export interface OrganizeManifest {
  instances: PageInstance[];
}

let instanceCounter = 0;

/** Fresh instance id — unique for the session, monotonic, not reused. */
export function newInstanceId(prefix = 'i'): string {
  instanceCounter += 1;
  return `${prefix}${instanceCounter}`;
}

export function sourceInstance(sourceId: string, sourcePage: number, rotation: Rotation = 0): PageInstance {
  return { instanceId: newInstanceId('p'), sourceId, sourcePage, blank: null, rotation };
}

export function blankInstance(spec: BlankSpec): PageInstance {
  return { instanceId: newInstanceId('b'), sourceId: null, sourcePage: null, blank: { ...spec }, rotation: 0 };
}

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

function rotateStep(cur: Rotation, delta: 90 | 180 | 270): Rotation {
  const idx = ROTATIONS.indexOf(cur);
  const steps = delta / 90;
  return ROTATIONS[(idx + steps) % 4] as Rotation;
}

/* ------------------------------- commands --------------------------------- */

export type OrganizeCommand =
  | { type: 'reorder'; order: string[] }
  | { type: 'rotate'; instanceIds: string[]; delta: 90 | 180 | 270 }
  | { type: 'delete'; instanceIds: string[] }
  | { type: 'duplicate'; instanceIds: string[] }
  | {
      type: 'insertBlank';
      /** null = insert at the top. */
      afterInstanceId: string | null;
      count: number;
      spec: BlankSpec;
    }
  | {
      type: 'insertSource';
      afterInstanceId: string | null;
      sourceId: string;
      sourcePages: number[];
    }
  | { type: 'setBookmark'; bookmarks: unknown };

export interface ApplyResult {
  manifest: OrganizeManifest;
  /** Instance ids CREATED by this command (duplicate/insert*) — the
   * inverse deletes exactly these. */
  createdIds: string[];
}

/** Apply one command; returns a NEW manifest (input never mutated). */
export function applyCommand(m: OrganizeManifest, cmd: OrganizeCommand): ApplyResult {
  switch (cmd.type) {
    case 'reorder': {
      if (cmd.order.length !== m.instances.length) {
        throw new Error(`reorder: ${cmd.order.length} ids != ${m.instances.length} instances`);
      }
      const byId = new Map(m.instances.map((p) => [p.instanceId, p] as const));
      const out = cmd.order.map((id) => {
        const inst = byId.get(id);
        if (!inst) throw new Error(`reorder: unknown instance ${id}`);
        return inst;
      });
      return { manifest: { instances: out }, createdIds: [] };
    }
    case 'rotate': {
      const ids = new Set(cmd.instanceIds);
      return {
        manifest: {
          instances: m.instances.map((p) =>
            ids.has(p.instanceId) ? { ...p, rotation: rotateStep(p.rotation, cmd.delta) } : p,
          ),
        },
        createdIds: [],
      };
    }
    case 'delete': {
      const ids = new Set(cmd.instanceIds);
      return { manifest: { instances: m.instances.filter((p) => !ids.has(p.instanceId)) }, createdIds: [] };
    }
    case 'duplicate': {
      const created: PageInstance[] = [];
      const out: PageInstance[] = [];
      for (const p of m.instances) {
        out.push(p);
        if (cmd.instanceIds.includes(p.instanceId)) {
          const copy: PageInstance = {
            instanceId: newInstanceId('d'),
            sourceId: p.sourceId,
            sourcePage: p.sourcePage,
            blank: p.blank ? { ...p.blank } : null,
            rotation: p.rotation,
          };
          created.push(copy);
          out.push(copy);
        }
      }
      return { manifest: { instances: out }, createdIds: created.map((c) => c.instanceId) };
    }
    case 'insertBlank': {
      const idx = anchorIndex(m, cmd.afterInstanceId);
      const created: PageInstance[] = [];
      for (let i = 0; i < cmd.count; i += 1) created.push(blankInstance(cmd.spec));
      const out = [...m.instances.slice(0, idx), ...created, ...m.instances.slice(idx)];
      return { manifest: { instances: out }, createdIds: created.map((c) => c.instanceId) };
    }
    case 'insertSource': {
      const idx = anchorIndex(m, cmd.afterInstanceId);
      const created = cmd.sourcePages.map((pg) => sourceInstance(cmd.sourceId, pg));
      const out = [...m.instances.slice(0, idx), ...created, ...m.instances.slice(idx)];
      return { manifest: { instances: out }, createdIds: created.map((c) => c.instanceId) };
    }
    case 'setBookmark':
      // Bookmarks live OUTSIDE the page manifest (their own tree + their
      // own history entries at the UI layer); a setBookmark command in a
      // page-manifest history is a caller bug.
      throw new Error('setBookmark belongs to the bookmark tree history, not the page manifest');
  }
}

function anchorIndex(m: OrganizeManifest, afterInstanceId: string | null): number {
  if (afterInstanceId === null) return 0;
  const idx = m.instances.findIndex((p) => p.instanceId === afterInstanceId);
  if (idx < 0) throw new Error(`insert: unknown anchor ${afterInstanceId}`);
  return idx + 1;
}
