import { describe, expect, it } from 'vitest';
import { assertValidDocument, type TextElement } from '@plakat/schema';
import { el, makeStore, rect, text } from './test-helpers.ts';

describe('pages', () => {
  it('adds after the active page, duplicates, reorders and keeps >= 1 page', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    const p1 = store.getState().activePageId;
    const p2 = a.addPage();
    expect(store.getState().document.pages.map((p) => p.id)).toEqual([p1, p2]);
    expect(store.getState().activePageId).toBe(p2);
    const p3 = a.duplicatePage(p1)!;
    const pages = store.getState().document.pages;
    expect(pages.map((p) => p.id)).toEqual([p1, p3, p2]);
    expect(pages[1]!.elements).toHaveLength(1);
    expect(pages[1]!.elements[0]!.id).not.toBe('a');
    a.movePage(p2, 0);
    expect(store.getState().document.pages.map((p) => p.id)).toEqual([p2, p1, p3]);
    expect(a.deletePage(p1)).toBe(true);
    expect(a.deletePage(p2)).toBe(true);
    expect(a.deletePage(p3)).toBe(false);
    expect(store.getState().document.pages).toHaveLength(1);
    expect(store.getState().activePageId).toBe(p3);
    a.undo();
    expect(store.getState().document.pages).toHaveLength(2);
  });

  it('deleting the active page activates a neighbour and reports pagesRemoved', () => {
    const { store } = makeStore([], { pageCount: 3 });
    const a = store.getState().actions;
    const [p1, p2, p3] = store.getState().document.pages.map((p) => p.id);
    a.setActivePage(p2!);
    a.deletePage();
    expect(store.getState().activePageId).toBe(p3);
    expect(store.getState().lastChange).toMatchObject({ pagesRemoved: [p2], pageOrderChanged: true });
    a.setActivePage(p3!);
    a.deletePage();
    expect(store.getState().activePageId).toBe(p1);
  });

  it('sets background color (validated) and image', () => {
    const { store } = makeStore();
    const a = store.getState().actions;
    a.setPageBackground(undefined, { color: '#FF0000' });
    expect(store.getState().document.pages[0]!.background.color).toBe('#ff0000');
    a.setPageBackground(undefined, { color: 'nope' });
    expect(store.getState().document.pages[0]!.background.color).toBe('#ff0000');
    a.setPageBackground(undefined, { image: { src: '/uploads/x.jpg', width: 10, height: 10, mimeType: 'image/jpeg' } });
    const bg = store.getState().document.pages[0]!.background.image!;
    expect(store.getState().document.assets[bg.assetId]).toBeTruthy();
    a.setPageBackground(undefined, { color: null, image: null });
    expect(store.getState().document.pages[0]!.background).toEqual({ color: null, image: null });
    assertValidDocument(store.getState().document);
  });

  it('renames a page and sets the title', () => {
    const { store } = makeStore();
    const a = store.getState().actions;
    a.renamePage(store.getState().activePageId, 'Cover');
    a.setTitle('Poster');
    expect(store.getState().document.pages[0]!.name).toBe('Cover');
    expect(store.getState().document.meta.title).toBe('Poster');
  });
});

describe('resizeDocument', () => {
  it("scales content uniformly and centers it ('scale', default)", () => {
    const { store } = makeStore([rect('a', 0, 0, 100, 100, { strokeWidth: 4 } as never), text('t', 100, 100, { fontSize: 40 } as never)]);
    store.getState().actions.resizeDocument({ width: 500, height: 1000, presetId: null, physical: null });
    expect(store.getState().document.size).toMatchObject({ width: 500, height: 1000 });
    // k = 0.5, offset y = (1000 - 500) / 2 = 250
    expect(el(store, 'a')).toMatchObject({ x: 0, y: 250, width: 50, height: 50, strokeWidth: 2 });
    expect(el(store, 't')).toMatchObject({ x: 50, y: 300 });
    expect((el(store, 't') as TextElement).fontSize).toBe(20);
    expect(store.getState().lastChange?.sizeChanged).toBe(true);
    assertValidDocument(store.getState().document);
  });

  it("keeps geometry with content: 'none' and accepts preset ids", () => {
    const { store } = makeStore([rect('a', 10, 10, 100, 100)]);
    store.getState().actions.resizeDocument('youtube-thumbnail', { content: 'none' });
    expect(store.getState().document.size).toMatchObject({ width: 1280, height: 720, presetId: 'youtube-thumbnail' });
    expect(el(store, 'a')).toMatchObject({ x: 10, y: 10, width: 100 });
    expect(() => store.getState().actions.resizeDocument({ width: 0, height: 10, presetId: null, physical: null })).toThrow(RangeError);
  });
});
