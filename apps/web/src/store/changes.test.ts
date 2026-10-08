import { describe, expect, it, vi } from 'vitest';
import { createDocument } from '@plakat/schema';
import { onDocumentChange } from './editor-store.ts';
import { makeStore, rect, text } from './test-helpers.ts';
import { selectSelectedElements, selectSelectionBounds, selectTransformerConfig, selectSlotsByElement } from './selectors.ts';

describe('change notifications', () => {
  it('reports changed / added / removed ids and pages', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10)], { pageCount: 2 });
    const a = store.getState().actions;
    const [p1] = store.getState().document.pages.map((p) => p.id);
    a.updateElement('a', { x: 5 });
    expect(store.getState().lastChange).toMatchObject({ source: 'commit', label: 'Edit', ids: ['a'], pages: [p1], added: [], removed: [] });
    a.deleteElements(['b']);
    expect(store.getState().lastChange).toMatchObject({ ids: ['b'], removed: ['b'] });
    a.undo();
    expect(store.getState().lastChange).toMatchObject({ source: 'undo', ids: ['b'], added: ['b'] });
    a.redo();
    expect(store.getState().lastChange).toMatchObject({ source: 'redo', removed: ['b'] });
  });

  it('rebuildText lists text whose face or characters changed only', () => {
    const { store } = makeStore([text('t'), text('u')]);
    const a = store.getState().actions;
    a.updateElement('t', { x: 4 });
    expect(store.getState().lastChange!.rebuildText).toEqual([]);
    a.setFontFamily(['t'], 'Roboto');
    expect(store.getState().lastChange!.rebuildText).toEqual(['t']);
    a.setTextContent('u', 'Żółw');
    expect(store.getState().lastChange!.rebuildText).toEqual(['u']);
  });

  it('openDocument emits a full change and resets history/selection', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.select(['a']);
    a.updateElement('a', { x: 1 });
    const doc = createDocument('instagram-story');
    a.openDocument(doc, { projectId: 'p1', version: 3 });
    const s = store.getState();
    expect(s.lastChange).toMatchObject({ full: true, source: 'load' });
    expect(s).toMatchObject({ canUndo: false, selectedIds: [], activePageId: doc.pages[0]!.id, projectId: 'p1', version: 3, saveStatus: 'saved' });
    expect(s.savedRevision).toBe(s.docRevision);
  });

  it('onDocumentChange fires synchronously once per change', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const fn = vi.fn();
    const off = onDocumentChange(fn, store);
    store.getState().actions.updateElement('a', { x: 3 });
    store.getState().actions.select(['a']); // not a document change
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0].ids).toEqual(['a']);
    off();
    store.getState().actions.undo();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('docRevision and saveStatus track edits', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const r0 = store.getState().docRevision;
    store.getState().actions.updateElement('a', { x: 3 });
    expect(store.getState().docRevision).toBe(r0 + 1);
    expect(store.getState().saveStatus).toBe('unsaved');
  });
});

describe('selectors', () => {
  it('are referentially stable', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10, { rotation: 45 })]);
    store.getState().actions.select(['a', 'b'], { expandGroups: false });
    const s = store.getState();
    expect(selectSelectedElements(s)).toBe(selectSelectedElements(store.getState()));
    expect(selectSelectionBounds(s)).toBe(selectSelectionBounds(store.getState()));
    expect(selectTransformerConfig(s)).toEqual({ keepRatio: true, enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], flipEnabled: false });
    expect(selectSlotsByElement(s)).toBe(selectSlotsByElement(store.getState()));
    store.getState().actions.setHovered('a');
    expect(selectSelectedElements(store.getState())).toBe(selectSelectedElements(s));
  });
});
