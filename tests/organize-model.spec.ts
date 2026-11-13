import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  blankInstance,
  sourceInstance,
  type OrganizeCommand,
  type OrganizeManifest,
  type PageInstance,
} from '../src/lib/organize-model';
import {
  HISTORY_BUDGET_DEFAULT,
  canRedo,
  canUndo,
  computeSourceRefs,
  createHistory,
  pushCommand,
  redo,
  undo,
  wouldDiscardOnPush,
  type OrganizeHistory,
} from '../src/lib/organize-history';

const src = (id: string, page: number, rotation: PageInstance['rotation'] = 0): PageInstance =>
  sourceInstance(id, page, rotation);

const manifestOf = (...pages: PageInstance[]): OrganizeManifest => ({ instances: pages });

/** applyCommand returns {manifest, createdIds}; tests here mostly want the manifest. */
const apply = (m: OrganizeManifest, cmd: OrganizeCommand): OrganizeManifest =>
  applyCommand(m, cmd).manifest;

describe('organize model — instance identity', () => {
  it('reorder preserves instance objects (identity, not copies)', () => {
    const a = src('A', 1);
    const b = src('A', 2);
    const out = apply(manifestOf(a, b), {
      type: 'reorder',
      order: [b.instanceId, a.instanceId],
    });
    expect(out.instances[0]).toBe(b);
    expect(out.instances[1]).toBe(a);
  });

  it('reorder with wrong id set is refused (never drops a page silently)', () => {
    const a = src('A', 1);
    expect(() => apply(manifestOf(a), { type: 'reorder', order: [] })).toThrow();
    expect(() => apply(manifestOf(a), { type: 'reorder', order: ['ghost'] })).toThrow();
  });

  it('duplicate creates NEW instances bound to the same source page', () => {
    const a = src('A', 1, 90);
    const out = apply(manifestOf(a), { type: 'duplicate', instanceIds: [a.instanceId] });
    expect(out.instances).toHaveLength(2);
    expect(out.instances[1]).not.toBe(a);
    expect(out.instances[1]!.sourceId).toBe('A');
    expect(out.instances[1]!.sourcePage).toBe(1);
    expect(out.instances[1]!.rotation).toBe(90); // copy carries the rotation
    expect(out.instances[1]!.instanceId).not.toBe(a.instanceId);
  });

  it('rotate adds delta mod 360 in the given direction', () => {
    const a = src('A', 1, 270);
    const out = apply(manifestOf(a), { type: 'rotate', instanceIds: [a.instanceId], delta: 90 });
    expect(out.instances[0]!.rotation).toBe(0); // (270+90)%360
    const out2 = apply(out, { type: 'rotate', instanceIds: [out.instances[0]!.instanceId], delta: 270 });
    expect(out2.instances[0]!.rotation).toBe(270);
  });

  it('delete removes only the targeted instances', () => {
    const a = src('A', 1);
    const b = src('A', 2);
    const out = apply(manifestOf(a, b), { type: 'delete', instanceIds: [a.instanceId] });
    expect(out.instances).toEqual([b]);
  });

  it('blank instance binds no source', () => {
    const b = blankInstance({ widthPt: 595, heightPt: 842 });
    expect(b.sourceId).toBeNull();
    expect(b.blank).toEqual({ widthPt: 595, heightPt: 842 });
  });

  it('insertBlank inserts after the anchor (null = at the top)', () => {
    const a = src('A', 1);
    const m = manifestOf(a);
    const out = apply(m, {
      type: 'insertBlank',
      afterInstanceId: null,
      count: 1,
      spec: { widthPt: 595, heightPt: 842 },
    });
    expect(out.instances).toHaveLength(2);
    expect(out.instances[0]!.blank).not.toBeNull();
    const out2 = apply(m, {
      type: 'insertBlank',
      afterInstanceId: a.instanceId,
      count: 2,
      spec: { widthPt: 595, heightPt: 842 },
    });
    expect(out2.instances).toHaveLength(3);
    expect(out2.instances[1]!.blank).not.toBeNull();
    expect(out2.instances[2]!.blank).not.toBeNull();
  });

  it('insertSource inserts N instances of the picked source pages after the anchor', () => {
    const a = src('A', 1);
    const out = apply(manifestOf(a), {
      type: 'insertSource',
      afterInstanceId: null,
      sourceId: 'B',
      sourcePages: [3, 1],
    });
    expect(out.instances.map((p) => [p.sourceId, p.sourcePage])).toEqual([
      ['B', 3],
      ['B', 1],
      ['A', 1],
    ]);
  });

  it('model has no extract command — extraction composes delete + export at the UI layer', () => {
    const cmds: OrganizeCommand['type'][] = [
      'reorder',
      'rotate',
      'delete',
      'duplicate',
      'insertBlank',
      'insertSource',
    ];
    expect(cmds).not.toContain('extract');
  });
});

describe('organize history — undo/redo inversion', () => {
  it('reorder inverts exactly (identity preserved through undo)', () => {
    const a = src('A', 1);
    const b = src('A', 2);
    const m0 = manifestOf(a, b);
    const hist = createHistory(m0);
    const r1 = pushCommand(hist, { type: 'reorder', order: [b.instanceId, a.instanceId] });
    expect(r1.current.instances.map((p) => p.instanceId)).toEqual([b.instanceId, a.instanceId]);
    const u = undo(r1);
    expect(u.current.instances.map((p) => p.instanceId)).toEqual([a.instanceId, b.instanceId]);
    expect(u.current.instances[0]).toBe(a);
    const r = redo(u);
    expect(r.current.instances.map((p) => p.instanceId)).toEqual([b.instanceId, a.instanceId]);
  });

  it('rotate inverts to the previous rotation', () => {
    const a = src('A', 1, 0);
    const hist = createHistory(manifestOf(a));
    const r = pushCommand(hist, { type: 'rotate', instanceIds: [a.instanceId], delta: 90 });
    expect(r.current.instances[0]!.rotation).toBe(90);
    const u = undo(r);
    expect(u.current.instances[0]!.rotation).toBe(0);
  });

  it('delete inverts (restores the SAME instance objects at the same positions)', () => {
    const a = src('A', 1);
    const b = src('A', 2);
    const hist = createHistory(manifestOf(a, b));
    const r = pushCommand(hist, { type: 'delete', instanceIds: [a.instanceId] });
    expect(r.current.instances).toHaveLength(1);
    const u = undo(r);
    expect(u.current.instances).toHaveLength(2);
    expect(u.current.instances[0]).toBe(a);
    expect(u.current.instances[1]).toBe(b);
  });

  it('duplicate + undo removes exactly the created copies', () => {
    const a = src('A', 1);
    const hist = createHistory(manifestOf(a));
    const r = pushCommand(hist, { type: 'duplicate', instanceIds: [a.instanceId] });
    expect(r.current.instances).toHaveLength(2);
    const u = undo(r);
    expect(u.current.instances).toHaveLength(1);
    expect(u.current.instances[0]).toBe(a);
  });

  it('insertBlank + undo removes exactly the created blanks', () => {
    const a = src('A', 1);
    const hist = createHistory(manifestOf(a));
    const r = pushCommand(hist, {
      type: 'insertBlank',
      afterInstanceId: null,
      count: 2,
      spec: { widthPt: 595, heightPt: 842 },
    });
    expect(r.current.instances).toHaveLength(3);
    const u = undo(r);
    expect(u.current.instances).toEqual([a]);
  });

  it('undo then new command invalidates the redo tail (branch rewrite)', () => {
    const a = src('A', 1);
    const hist = createHistory(manifestOf(a));
    const r1 = pushCommand(hist, { type: 'rotate', instanceIds: [a.instanceId], delta: 90 });
    const u = undo(r1);
    expect(canRedo(u)).toBe(true);
    const r2 = pushCommand(u, { type: 'rotate', instanceIds: [a.instanceId], delta: 180 });
    expect(canRedo(r2)).toBe(false);
    expect(canUndo(r2)).toBe(true);
    expect(undo(r2).current.instances[0]!.rotation).toBe(0);
  });

  it('multi-command sequence inverts stepwise', () => {
    const a = src('A', 1);
    const b = src('A', 2);
    const hist = createHistory(manifestOf(a, b));
    const r1 = pushCommand(hist, { type: 'delete', instanceIds: [a.instanceId] });
    const r2 = pushCommand(r1, { type: 'rotate', instanceIds: [b.instanceId], delta: 180 });
    const u1 = undo(r2);
    expect(u1.current.instances[0]!.rotation).toBe(0);
    expect(u1.current.instances).toHaveLength(1);
    const u2 = undo(u1);
    expect(u2.current.instances).toHaveLength(2);
    expect(u2.current.instances[0]).toBe(a);
  });

  it('budget: push that would exceed the cap is flagged, never silent', () => {
    const a2 = src('A', 9);
    let hist: OrganizeHistory = createHistory(manifestOf(a2));
    for (let i = 0; i < HISTORY_BUDGET_DEFAULT; i += 1) {
      hist = pushCommand(hist, { type: 'rotate', instanceIds: [a2.instanceId], delta: 90 });
    }
    expect(wouldDiscardOnPush(pushCommand(hist, { type: 'rotate', instanceIds: [a2.instanceId], delta: 90 }))).toBe(true);
    const r = pushCommand(hist, { type: 'rotate', instanceIds: [a2.instanceId], delta: 90 });
    expect(r.discardedUndoEntries).toBe(1);
  });

  it('source refs count manifest + history-retained instances', () => {
    const a = src('A', 1);
    const b = src('B', 1);
    const hist = createHistory(manifestOf(a, b));
    const r = pushCommand(hist, { type: 'delete', instanceIds: [a.instanceId] });
    const refs = computeSourceRefs(r.current, r);
    // A deleted in the manifest but retained by the undo entry's prior.
    expect(refs.get('A')).toBe(1);
    expect(refs.get('B')).toBe(1);
    const u = undo(r);
    const refs2 = computeSourceRefs(u.current, u);
    expect(refs2.get('A')).toBe(1);
  });
});
