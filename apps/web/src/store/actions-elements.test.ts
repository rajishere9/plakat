import { describe, expect, it } from 'vitest';
import { assertValidDocument, getElementBounds, type ImageElement, type TextElement } from '@plakat/schema';
import { el, makeStore, page0, rect, text } from './test-helpers.ts';

const PNG = { src: '/uploads/abc.png', width: 400, height: 200, mimeType: 'image/png' as const, name: 'pic' };

describe('add elements', () => {
  it('adds text centered on the active page and selects it', () => {
    const { store } = makeStore();
    const id = store.getState().actions.addText({ preset: 'heading' });
    const t = el(store, id) as TextElement;
    expect(t.type).toBe('text');
    expect(t.fontWeight).toBe(700);
    expect(t.fontSize).toBe(80); // 8 % of 1000
    const b = getElementBounds(t);
    expect(b.x + b.width / 2).toBeCloseTo(500);
    expect(b.y + b.height / 2).toBeCloseTo(500);
    expect(store.getState().selectedIds).toEqual([id]);
    expect(store.getState().lastChange?.added).toEqual([id]);
    expect(store.getState().lastChange?.rebuildText).toEqual([id]);
  });

  it('adds shapes and lines', () => {
    const { store } = makeStore();
    const a = store.getState().actions;
    const r = a.addShape('rect', { fill: '#ff0000' });
    const l = a.addShape('line');
    expect(el(store, r)).toMatchObject({ shape: 'rect', fill: '#ff0000', width: 300, height: 300, x: 350, y: 350 });
    expect(el(store, l)).toMatchObject({ shape: 'line', stroke: '#000000' });
    expect(page0(store).elements.map((e) => e.id)).toEqual([r, l]);
  });

  it('adds images with a new asset (dedupe by src) or an existing asset id', () => {
    const { store } = makeStore();
    const a = store.getState().actions;
    const i1 = a.addImage(PNG);
    const i2 = a.addImage(PNG);
    const doc = store.getState().document;
    expect(Object.keys(doc.assets)).toHaveLength(1);
    const e1 = el(store, i1) as ImageElement;
    expect((el(store, i2) as ImageElement).assetId).toBe(e1.assetId);
    expect(e1.width).toBeCloseTo(400); // natural size (never upscaled; capped at 60 % of the short side)
    expect(e1.height).toBeCloseTo(200);
    const i3 = a.addImage({ assetId: e1.assetId }, {}, { keepPosition: true });
    expect(el(store, i3)).toMatchObject({ x: 0, y: 0 });
    assertValidDocument(store.getState().document);
    expect(() => a.addImage({ assetId: 'as_missing' })).toThrow(/Unknown asset/);
    expect(() => a.addImage({ ...PNG, src: 'javascript:alert(1)' })).toThrow(/Invalid image asset/);
  });

  it('adds to a specific page without selecting', () => {
    const { store } = makeStore([], { pageCount: 2 });
    const p2 = store.getState().document.pages[1]!.id;
    const id = store.getState().actions.addShape('ellipse', {}, { pageId: p2, select: false });
    expect(store.getState().document.pages[1]!.elements[0]!.id).toBe(id);
    expect(store.getState().selectedIds).toEqual([]);
  });
});

describe('update elements', () => {
  it('clamps values to schema ranges and drops invalid / foreign fields', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), text('t')]);
    const a = store.getState().actions;
    a.updateElement('a', { opacity: 3, strokeWidth: -5, sides: 100.4, fill: 'red' as never, rotation: -90 });
    expect(el(store, 'a')).toMatchObject({ opacity: 1, strokeWidth: 0, sides: 64, fill: '#cccccc', rotation: 270 });
    a.updateElement('t', { fontSize: 99999, lineHeight: 0.1, fontWeight: 650 as never, cornerRadius: 5 } as never);
    expect(el(store, 't')).toMatchObject({ fontSize: 5000, lineHeight: 0.5, fontWeight: 700 });
    expect('cornerRadius' in el(store, 't')).toBe(false);
    a.updateElement('a', { x: Number.NaN });
    expect(el(store, 'a').x).toBe(0);
    assertValidDocument(store.getState().document);
  });

  it('updateElements applies a function per element in one undo step', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 5, 0, 10, 10)]);
    const a = store.getState().actions;
    a.updateElements(['a', 'b'], (e) => ({ x: e.x + 100 }));
    expect(el(store, 'a').x).toBe(100);
    expect(el(store, 'b').x).toBe(105);
    a.undo();
    expect(el(store, 'b').x).toBe(5);
  });

  it('commitTransforms bakes scale, normalizes rotation and always reports touched ids', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 20), text('t', 0, 0, { fontSize: 20 } as never), rect('l', 0, 0, 5, 5, { locked: true })]);
    const a = store.getState().actions;
    a.commitTransforms({
      a: { x: 5, y: 6, rotation: -45, scaleX: 2, scaleY: 3 },
      t: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 },
      l: { x: 50, y: 50, rotation: 0, scaleX: 1, scaleY: 1 },
    });
    expect(el(store, 'a')).toMatchObject({ x: 5, y: 6, width: 20, height: 60, rotation: 315 });
    expect(el(store, 't')).toMatchObject({ width: 400, fontSize: 40 });
    expect(el(store, 'l')).toMatchObject({ x: 0, y: 0 });
    expect(store.getState().undoLabel).toBe('Resize');
    // A no-op transform (snap-back) still notifies the canvas.
    const seq = store.getState().lastChange!.seq;
    a.commitTransforms({ a: { x: 5, y: 6, rotation: 315, scaleX: 1, scaleY: 1 } });
    expect(store.getState().lastChange!.seq).toBe(seq + 1);
    expect(store.getState().lastChange!.ids).toEqual(['a']);
    expect(store.getState().undoLabel).toBe('Resize');
    // Mirror cannot be represented: skipped, no throw.
    a.commitTransforms({ a: { x: 0, y: 0, rotation: 0, scaleX: -1, scaleY: 1 } });
    expect(el(store, 'a').x).toBe(5);
  });

  it('moveElements and setRotation (about the center)', () => {
    const { store } = makeStore([rect('a', 0, 0, 100, 50)]);
    const a = store.getState().actions;
    a.moveElements(['a'], 10, 20);
    expect(el(store, 'a')).toMatchObject({ x: 10, y: 20 });
    a.setRotation(['a'], 90);
    const e = el(store, 'a');
    expect(e.rotation).toBe(90);
    const b = getElementBounds(e);
    expect(b.x + b.width / 2).toBeCloseTo(60);
    expect(b.y + b.height / 2).toBeCloseTo(45);
  });
});

describe('delete / duplicate / lock / hide / rename', () => {
  it('deletes the selection but keeps locked elements unless forced', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10, { locked: true })]);
    const a = store.getState().actions;
    a.select(['a', 'b']);
    a.deleteElements();
    expect(page0(store).elements.map((e) => e.id)).toEqual(['b']);
    expect(store.getState().selectedIds).toEqual(['b']);
    a.deleteElements(['b'], { force: true });
    expect(page0(store).elements).toHaveLength(0);
    expect(store.getState().lastChange?.removed).toEqual(['b']);
  });

  it('delete prunes template slot targets', () => {
    const { store } = makeStore([text('t'), text('u')]);
    const a = store.getState().actions;
    a.convertToTemplate();
    a.addSlot('t');
    a.deleteElements(['t']);
    expect(store.getState().document.template!.slots).toHaveLength(0);
    assertValidDocument(store.getState().document);
  });

  it('duplicates +16 px above the topmost original with fresh ids and remapped groups', () => {
    const { store } = makeStore([
      rect('a', 0, 0, 10, 10, { groupId: 'g1' }),
      rect('b', 20, 0, 10, 10, { groupId: 'g1' }),
      rect('c', 0, 0, 10, 10),
    ]);
    const a = store.getState().actions;
    a.select(['a']); // expands to group
    const ids = a.duplicateElements();
    expect(ids).toHaveLength(2);
    const els = page0(store).elements;
    expect(els.map((e) => e.id)).toEqual(['a', 'b', ...ids, 'c']);
    const [c1, c2] = ids.map((id) => el(store, id));
    expect(c1).toMatchObject({ x: 16, y: 16 });
    expect(c2).toMatchObject({ x: 36, y: 16 });
    expect(c1!.groupId).toBe(c2!.groupId);
    expect(c1!.groupId).not.toBe('g1');
    expect(store.getState().selectedIds).toEqual(ids);
  });

  it('toggles lock / hidden and renames', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10, { locked: true })]);
    const a = store.getState().actions;
    a.toggleLock(['a', 'b']);
    expect([el(store, 'a').locked, el(store, 'b').locked]).toEqual([true, true]);
    a.toggleLock(['a', 'b']);
    expect([el(store, 'a').locked, el(store, 'b').locked]).toEqual([false, false]);
    a.toggleHidden(['a']);
    expect(el(store, 'a').hidden).toBe(true);
    a.rename('a', 'Background');
    expect(el(store, 'a').name).toBe('Background');
  });
});

describe('fonts', () => {
  it('setFontFamily adapts weight/style to the catalog', () => {
    const { store } = makeStore([text('t', 0, 0, { fontWeight: 700, fontStyle: 'italic' } as never)]);
    store.getState().actions.setFontFamily(['t'], 'Lobster');
    expect(el(store, 't')).toMatchObject({ fontFamily: 'Lobster', fontWeight: 400, fontStyle: 'normal' });
  });

  it('toggles bold and italic', () => {
    const { store } = makeStore([text('t'), text('u', 0, 0, { fontWeight: 700 } as never)]);
    const a = store.getState().actions;
    a.toggleBold(['t', 'u']);
    expect([(el(store, 't') as TextElement).fontWeight, (el(store, 'u') as TextElement).fontWeight]).toEqual([700, 700]);
    a.toggleBold(['t', 'u']);
    expect((el(store, 't') as TextElement).fontWeight).toBe(400);
    a.toggleItalic(['t']);
    expect((el(store, 't') as TextElement).fontStyle).toBe('italic');
    a.toggleItalic(['t']);
    expect((el(store, 't') as TextElement).fontStyle).toBe('normal');
  });
});

describe('images', () => {
  function withImage() {
    const { store } = makeStore();
    const a = store.getState().actions;
    const id = a.addImage(PNG, { width: 100, height: 100 }, { keepPosition: true });
    return { store, a, id };
  }

  it('setCrop fits the crop into the image; null resets', () => {
    const { store, a, id } = withImage();
    a.setCrop(id, { x: 350, y: 0, width: 100, height: 100 }, { box: { width: 50, height: 50 } });
    expect((el(store, id) as ImageElement).crop).toEqual({ x: 300, y: 0, width: 100, height: 100 });
    expect(el(store, id)).toMatchObject({ width: 50, height: 50 });
    a.setCrop(id, null);
    expect((el(store, id) as ImageElement).crop).toBeNull();
  });

  it('replaceImage keeps framing proportionally and valid', () => {
    const { store, a, id } = withImage();
    a.setCrop(id, { x: 100, y: 0, width: 200, height: 200 });
    const oldAssetId = (el(store, id) as ImageElement).assetId;
    a.replaceImage(id, { src: '/uploads/big.png', width: 800, height: 400, mimeType: 'image/png' });
    const e = el(store, id) as ImageElement;
    expect(e.crop).toEqual({ x: 200, y: 0, width: 400, height: 400 });
    expect(e.assetId).not.toBe(oldAssetId);
    assertValidDocument(store.getState().document);
    // Different aspect: still undistorted (box aspect 1) and inside the image.
    a.replaceImage(id, { src: '/uploads/tall.png', width: 100, height: 300, mimeType: 'image/png' });
    const c = (el(store, id) as ImageElement).crop!;
    expect(c.width / c.height).toBeCloseTo(1);
    expect(c.x + c.width).toBeLessThanOrEqual(100.0001);
    assertValidDocument(store.getState().document);
  });

  it('filters are clamped and coalesced; flip toggles', () => {
    const { store, a, id } = withImage();
    a.setFilters([id], { brightness: 50 });
    a.setFilters([id], { brightness: 500, blur: -3 });
    expect((el(store, id) as ImageElement).filters).toMatchObject({ brightness: 100, blur: 0, contrast: 0 });
    a.undo();
    expect((el(store, id) as ImageElement).filters.brightness).toBe(0);
    a.flip([id], 'x');
    expect((el(store, id) as ImageElement).flipX).toBe(true);
    a.resetFilters([id]);
  });

  it('crop mode / text editing modes', () => {
    const { store, a, id } = withImage();
    a.enterCropMode(id);
    expect(store.getState().cropModeId).toBe(id);
    expect(store.getState().selectedIds).toEqual([id]);
    a.escape();
    expect(store.getState().cropModeId).toBeNull();
    expect(store.getState().selectedIds).toEqual([id]);
    a.escape();
    expect(store.getState().selectedIds).toEqual([]);
    a.startTextEditing(id); // not a text element: ignored
    expect(store.getState().textEditingId).toBeNull();
  });
});
