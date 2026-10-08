import { describe, expect, it } from 'vitest';
import { removeElements } from '@plakat/schema';
import { History } from './history.ts';
import { el, makeStore, page0, rect, text } from './test-helpers.ts';

describe('commit / undo / redo', () => {
  it('records one undo step per commit and restores the document', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.updateElement('a', { x: 50 });
    a.updateElement('a', { y: 70 });
    expect(el(store, 'a')).toMatchObject({ x: 50, y: 70 });
    expect(store.getState().canUndo).toBe(true);
    expect(store.getState().undoLabel).toBe('Edit');
    a.undo();
    expect(el(store, 'a')).toMatchObject({ x: 50, y: 0 });
    a.undo();
    expect(el(store, 'a')).toMatchObject({ x: 0, y: 0 });
    expect(store.getState().canUndo).toBe(false);
    expect(a.undo()).toBe(false);
    a.redo();
    a.redo();
    expect(el(store, 'a')).toMatchObject({ x: 50, y: 70 });
    expect(store.getState().canRedo).toBe(false);
  });

  it('a new commit clears the redo stack', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.updateElement('a', { x: 1 });
    a.undo();
    expect(store.getState().canRedo).toBe(true);
    a.updateElement('a', { x: 2 });
    expect(store.getState().canRedo).toBe(false);
  });

  it('no-op commits do not create history entries', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const r = store.getState().actions.commit('noop', () => {});
    expect(r.changed).toBe(false);
    store.getState().actions.updateElement('a', { x: 0 });
    expect(store.getState().canUndo).toBe(false);
  });

  it('restores the selection before/after on undo/redo', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)]);
    const a = store.getState().actions;
    a.select(['a']);
    a.deleteElements();
    expect(store.getState().selectedIds).toEqual([]);
    a.select(['b']);
    a.undo();
    expect(page0(store).elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(store.getState().selectedIds).toEqual(['a']);
    a.redo();
    expect(store.getState().selectedIds).toEqual([]);
  });

  it('undo of an add re-selects nothing, redo re-selects the added element', () => {
    const { store } = makeStore();
    const a = store.getState().actions;
    const id = a.addShape('rect');
    expect(store.getState().selectedIds).toEqual([id]);
    a.undo();
    expect(store.getState().selectedIds).toEqual([]);
    a.redo();
    expect(store.getState().selectedIds).toEqual([id]);
  });

  it('recipes may return a document from a pure helper (reconciled into fine patches)', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10)]);
    const before = store.getState().document;
    store.getState().actions.commit('Delete', (_d, base) => removeElements(base, ['a']));
    const after = store.getState().document;
    expect(after.pages[0]!.elements.map((e) => e.id)).toEqual(['b']);
    expect(after.pages[0]!.elements[0]).toBe(before.pages[0]!.elements[1]); // structural sharing kept
    expect(after.assets).toBe(before.assets);
    store.getState().actions.undo();
    expect(store.getState().document.pages[0]!.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('a throwing recipe leaves state untouched', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const doc = store.getState().document;
    expect(() =>
      store.getState().actions.commit('bad', (d) => {
        d.pages[0]!.elements[0]!.x = 99;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getState().document).toBe(doc);
    expect(store.getState().canUndo).toBe(false);
  });
});

describe('coalescing', () => {
  it('merges commits with the same key inside the window', () => {
    const { store, clock } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.nudge(1, 0, ['a']);
    clock.advance(300);
    a.nudge(1, 0, ['a']);
    clock.advance(300);
    a.nudge(0, 10, ['a']);
    expect(el(store, 'a')).toMatchObject({ x: 2, y: 10 });
    a.undo();
    expect(el(store, 'a')).toMatchObject({ x: 0, y: 0 });
    expect(store.getState().canUndo).toBe(false);
  });

  it('starts a new step after the window or with another key', () => {
    const { store, clock } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.nudge(1, 0, ['a']);
    clock.advance(1500);
    a.nudge(1, 0, ['a']);
    a.updateElement('a', { opacity: 0.5 }, { coalesceKey: 'other' });
    a.undo();
    expect(el(store, 'a')).toMatchObject({ x: 2, opacity: 1 });
    a.undo();
    expect(el(store, 'a').x).toBe(1);
  });

  it('typing coalesces per element for the whole edit session and collapses patches', () => {
    const { store, clock } = makeStore([text('t')]);
    const a = store.getState().actions;
    a.startTextEditing('t');
    let s = '';
    for (const ch of 'Hello world') {
      s += ch;
      a.setTextContent('t', s);
      clock.advance(5000);
    }
    a.stopTextEditing();
    a.setTextContent('t', 'Other');
    a.undo();
    expect((el(store, 't') as { content: string }).content).toBe('Hello world');
    a.undo();
    expect((el(store, 't') as { content: string }).content).toBe('Hello');
  });

  it('breakCoalescing seals the run; merge:true appends to the previous step', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.updateElement('a', { x: 5 }, { coalesceKey: 'k' });
    a.breakCoalescing();
    a.updateElement('a', { x: 6 }, { coalesceKey: 'k' });
    a.updateElement('a', { height: 99 }, { merge: true });
    a.undo();
    expect(el(store, 'a')).toMatchObject({ x: 5, height: 10 });
  });

  it('undo seals: the next commit with the same key does not merge into the undone step', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.updateElement('a', { x: 1 }, { coalesceKey: 'k' });
    a.updateElement('a', { y: 1 }, { coalesceKey: 'other' });
    a.undo();
    a.updateElement('a', { x: 2 }, { coalesceKey: 'k' });
    a.undo();
    expect(el(store, 'a')).toMatchObject({ x: 1, y: 0 });
  });
});

describe('History', () => {
  it('caps the number of entries', () => {
    const { store } = createCapped(5);
    const a = store.getState().actions;
    for (let i = 1; i <= 8; i++) a.updateElement('a', { x: i });
    let n = 0;
    while (a.undo()) n++;
    expect(n).toBe(5);
    expect(el(store, 'a').x).toBe(3);
  });

  it('collapses replace patches of a coalesced run', () => {
    const h = new History();
    const sel = { ids: [], pageId: 'p' };
    const mk = (v: number, old: number) => ({
      label: 'x',
      patches: [{ op: 'replace' as const, path: ['a'], value: v }],
      inversePatches: [{ op: 'replace' as const, path: ['a'], value: old }],
      selectionBefore: sel,
      selectionAfter: sel,
      coalesceKey: 'k',
      time: 0,
    });
    h.push(mk(1, 0), { coalesceKey: 'k' });
    h.push(mk(2, 1), { coalesceKey: 'k' });
    h.push(mk(3, 2), { coalesceKey: 'k' });
    expect(h.past).toHaveLength(1);
    expect(h.past[0]!.patches).toEqual([{ op: 'replace', path: ['a'], value: 3 }]);
    expect(h.past[0]!.inversePatches).toEqual([{ op: 'replace', path: ['a'], value: 0 }]);
  });
});

import { createEditorStore } from './editor-store.ts';
import { docWith } from './test-helpers.ts';
function createCapped(limit: number) {
  return { store: createEditorStore({ document: docWith([rect('a', 0, 0, 10, 10)]), historyLimit: limit }) };
}
