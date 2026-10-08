import { describe, expect, it } from 'vitest';
import { assertValidDocument, createImageElement, type ImageElement } from '@plakat/schema';
import { clipboardHtml, clipboardPlainText, parseClipboard, parseClipboardHtml, serializeClipboard } from '../lib/clipboard.ts';
import { createEditorStore } from './editor-store.ts';
import { docWith, el, makeStore, page0, rect, text } from './test-helpers.ts';

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgo=';

describe('clipboard', () => {
  it('copy + paste on the same page offsets by 16 px per paste and selects the copies', () => {
    const { store } = makeStore([rect('a', 10, 10, 10, 10)]);
    const a = store.getState().actions;
    a.select(['a']);
    a.copy();
    const p1 = a.paste();
    const p2 = a.paste();
    expect(el(store, p1[0]!)).toMatchObject({ x: 26, y: 26 });
    expect(el(store, p2[0]!)).toMatchObject({ x: 42, y: 42 });
    expect(store.getState().selectedIds).toEqual(p2);
    expect(p1[0]).not.toBe('a');
  });

  it('pastes at the same position on another page', () => {
    const { store } = makeStore([rect('a', 10, 10, 10, 10)], { pageCount: 2 });
    const a = store.getState().actions;
    a.copy(['a']);
    const p2 = store.getState().document.pages[1]!.id;
    a.setActivePage(p2);
    const ids = a.paste();
    expect(store.getState().document.pages[1]!.elements.map((e) => e.id)).toEqual(ids);
    expect(el(store, ids[0]!)).toMatchObject({ x: 10, y: 10 });
    expect(store.getState().activePageId).toBe(p2);
    expect(store.getState().selectedIds).toEqual(ids);
  });

  it('cut removes the originals and pastes in place', () => {
    const { store } = makeStore([rect('a', 10, 10, 10, 10)]);
    const a = store.getState().actions;
    a.select(['a']);
    a.cut();
    expect(store.getState().document.pages[0]!.elements).toHaveLength(0);
    const ids = a.paste();
    expect(el(store, ids[0]!)).toMatchObject({ x: 10, y: 10 });
    a.undo();
    a.undo();
    expect(el(store, 'a')).toBeTruthy();
  });

  it('copies a group as a unit (new group id) and keeps z-order', () => {
    const { store } = makeStore([rect('a', 0, 0, 1, 1, { groupId: 'g' }), rect('x', 0, 0, 1, 1), rect('b', 0, 0, 1, 1, { groupId: 'g' })]);
    const a = store.getState().actions;
    a.copy(['b']);
    expect(store.getState().clipboard!.elements.map((e) => e.id)).toEqual(['a', 'b']);
    const ids = a.paste();
    const g = ids.map((id) => el(store, id).groupId);
    expect(g[0]).toBe(g[1]);
    expect(g[0]).not.toBe('g');
  });

  it('pastes across documents, merging assets without clobbering a different asset with the same id', () => {
    const src = docWith([]);
    src.assets['as_logo'] = { type: 'image', mimeType: 'image/png', width: 10, height: 10, src: PNG_DATA, name: 'A', source: null };
    src.pages[0]!.elements.push(createImageElement('as_logo', { width: 10, height: 10 }, { id: 'img' }));
    const s1 = createEditorStore({ document: src });
    s1.getState().actions.copy(['img']);
    const data = s1.getState().clipboard!;

    const target = docWith([]);
    target.assets['as_logo'] = { type: 'image', mimeType: 'image/png', width: 20, height: 20, src: '/uploads/other.png', name: 'B', source: null };
    const s2 = createEditorStore({ document: target });
    // Internal clipboard carries over when another document is opened in the same store:
    s1.getState().actions.openDocument(target);
    const ids = s1.getState().actions.paste();
    const pasted = el(s1, ids[0]!) as ImageElement;
    expect(pasted.assetId).not.toBe('as_logo');
    expect(s1.getState().document.assets[pasted.assetId]!.src).toBe(PNG_DATA);
    expect(s1.getState().document.assets['as_logo']!.src).toBe('/uploads/other.png');
    assertValidDocument(s1.getState().document);

    // Through the system clipboard (serialize/parse) into a separate store:
    const parsed = parseClipboard(serializeClipboard(data))!;
    const ids2 = s2.getState().actions.paste(parsed);
    expect((el(s2, ids2[0]!) as ImageElement).assetId).not.toBe('as_logo');
    assertValidDocument(s2.getState().document);
  });

  it('parseClipboard rejects garbage and invalid elements', () => {
    expect(parseClipboard('nope')).toBeNull();
    expect(parseClipboard(JSON.stringify({ format: 'other' }))).toBeNull();
    expect(parseClipboard(JSON.stringify({ format: 'plakat.clipboard', elements: [{ type: 'text' }], assets: {} }))).toBeNull();
    expect(
      parseClipboard(JSON.stringify({ format: 'plakat.clipboard', elements: [{ id: 'i', type: 'image', x: 0, y: 0, width: 1, height: 1, assetId: 'as_missing' }], assets: {} })),
    ).toBeNull();
  });

  it('cascades repeated pastes of the same system-clipboard payload (same page and other pages)', () => {
    const { store } = makeStore([rect('a', 10, 10, 10, 10)], { pageCount: 2 });
    const a = store.getState().actions;
    a.select(['a']);
    const data = parseClipboard(serializeClipboard(a.copy()!))!;
    const pos = () => page0(store).elements.map((e) => [e.x, e.y]);
    a.paste(data);
    a.paste(data);
    a.paste(data);
    expect(pos()).toEqual([[10, 10], [26, 26], [42, 42], [58, 58]]);
    // On a page without the originals: the first paste keeps the position, later ones cascade.
    const p2 = store.getState().document.pages[1]!.id;
    a.setActivePage(p2);
    a.paste(data);
    a.paste(data);
    expect(store.getState().document.pages[1]!.elements.map((e) => [e.x, e.y])).toEqual([[10, 10], [26, 26]]);
    // A new copy restarts the series.
    a.setActivePage(page0(store).id);
    a.select(['a']);
    const again = parseClipboard(serializeClipboard(a.copy()!))!;
    const ids = a.paste(again);
    expect(el(store, ids[0]!)).toMatchObject({ x: 26, y: 26 });
  });

  it('cut copies locked elements but only removes the unlocked ones', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10, { locked: true }), rect('b', 20, 20, 10, 10)]);
    const a = store.getState().actions;
    const data = a.cut(['a', 'b'])!;
    expect(data.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(page0(store).elements.map((e) => e.id)).toEqual(['a']);
    // All locked: nothing removed, no history entry.
    const before = store.getState().undoLabel;
    a.cut(['a']);
    expect(page0(store).elements.map((e) => e.id)).toEqual(['a']);
    expect(store.getState().undoLabel).toBe(before);
  });

  it('parseClipboard refuses other payload versions and repairs crops outside the asset', () => {
    const asset = { type: 'image', mimeType: 'image/png', width: 10, height: 10, src: PNG_DATA, name: '', source: null };
    const img = { ...createImageElement('as_x', { width: 10, height: 10 }, { id: 'img' }), width: 100, height: 100, crop: { x: 0, y: 0, width: 500, height: 500 } };
    const payload = { format: 'plakat.clipboard', version: 1, elements: [img], assets: { as_x: asset }, sourceDocumentId: null, sourcePageId: null };
    expect(parseClipboard(JSON.stringify({ ...payload, version: 2 }))).toBeNull();
    expect(parseClipboard(JSON.stringify({ ...payload, version: undefined }))).toBeNull();
    const parsed = parseClipboard(JSON.stringify(payload))!;
    const crop = (parsed.elements[0] as ImageElement).crop!;
    expect(crop.width).toBeLessThanOrEqual(10);
    expect(crop.height).toBeLessThanOrEqual(10);
    const { store } = makeStore();
    const ids = store.getState().actions.paste(parsed);
    expect(ids).toHaveLength(1);
    assertValidDocument(store.getState().document);
  });

  it('insertElements refuses content that would make the document invalid', () => {
    const { store } = makeStore();
    const bad = { ...createImageElement('as_x', { width: 10, height: 10 }, { id: 'img' }), crop: { x: 0, y: 0, width: 500, height: 500 } };
    const asset = { type: 'image' as const, mimeType: 'image/png' as const, width: 10, height: 10, src: PNG_DATA, name: '', source: null };
    const ids = store.getState().actions.insertElements([bad], { as_x: asset });
    expect(ids).toEqual([]);
    expect(page0(store).elements).toHaveLength(0);
    expect(store.getState().lastError).toMatch(/Could not insert/);
    expect(store.getState().canUndo).toBe(false);
  });

  it('text/plain carries only the copied text; the payload rides in text/html too', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), text('t', 0, 0, { content: 'Hi <there>' } as never)]);
    const data = store.getState().actions.copy(['a', 't'])!;
    expect(clipboardPlainText(data)).toBe('Hi <there>');
    const html = clipboardHtml(data);
    expect(html).not.toContain('"format"');
    expect(parseClipboardHtml(html)!.elements.map((e) => e.id)).toEqual(['a', 't']);
    expect(parseClipboardHtml('<p>hello</p>')).toBeNull();
  });
});
