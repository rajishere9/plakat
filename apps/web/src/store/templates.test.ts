import { describe, expect, it } from 'vitest';
import { addBrandColor, addBrandLogo, assertValidDocument, createBrandKit, setBrandFont, TemplateError, type ImageElement, type TextElement } from '@plakat/schema';
import { el, makeStore, page0, rect, text } from './test-helpers.ts';

const LOGO = { type: 'image' as const, mimeType: 'image/png' as const, width: 50, height: 20, src: '/uploads/logo.png', name: 'Logo', source: null };

describe('template slots', () => {
  it('converts in place, adds / edits / fills / removes slots with undo', () => {
    const { store } = makeStore([text('t'), rect('r', 0, 0, 10, 10)]);
    const a = store.getState().actions;
    a.select(['t']);
    a.convertToTemplate('social');
    expect(store.getState().document.kind).toBe('template');
    expect(store.getState().selectedIds).toEqual(['t']); // ids preserved
    const slot = a.addSlot('t');
    expect(slot.kind).toBe('text');
    const color = a.addSlot({ kind: 'color', targets: ['r'], label: 'Accent' });
    a.updateSlot(slot.id, { label: 'Headline', maxLength: 20 });
    a.fillSlot(slot.id, { text: 'Big sale' });
    a.fillSlot(color.id, { color: '#123456' });
    expect((el(store, 't') as TextElement).content).toBe('Big sale');
    expect(el(store, 'r')).toMatchObject({ fill: '#123456' });
    expect(() => a.fillSlot(slot.id, { text: 'x'.repeat(30) })).toThrow(TemplateError);
    expect(store.getState().lastError).toMatch(/at most 20/);
    a.moveSlot(color.id, 0);
    expect(store.getState().document.template!.slots.map((s) => s.label)).toEqual(['Accent', 'Headline']);
    a.removeSlot(color.id);
    expect(store.getState().document.template!.slots).toHaveLength(1);
    assertValidDocument(store.getState().document);
    a.undo();
    expect(store.getState().document.template!.slots).toHaveLength(2);
    expect(() => a.addSlot({ kind: 'image', targets: ['t'] })).toThrow(TemplateError);
    a.setTemplateCategory('print');
    expect(store.getState().document.template!.category).toBe('print');
    a.convertToDesign();
    expect(store.getState().document).toMatchObject({ kind: 'design', template: null });
  });
});

describe('brand kits', () => {
  function kit() {
    let k = createBrandKit('Acme');
    k = addBrandColor(k, '#ff0000', 'Primary');
    k = setBrandFont(k, { role: 'heading', family: 'Playfair Display', weight: 700 }).kit;
    k = setBrandFont(k, { role: 'body', family: 'Lato' }).kit;
    return addBrandLogo(k, LOGO, 'Logo');
  }

  it('manages kits and applies one to the document (one undo step)', () => {
    const { store } = makeStore([text('h', 0, 0, { fontSize: 80, fill: '#000000' } as never), text('b', 0, 0, { fontSize: 20 } as never)]);
    const a = store.getState().actions;
    const { kit: k } = kit();
    a.setBrandKits([k]);
    expect(store.getState().activeBrandKitId).toBe(k.id);
    a.applyBrandKit();
    // most used color is #000000 (two texts) -> #ff0000; background #ffffff stays (kit has 1 color)
    expect(el(store, 'h')).toMatchObject({ fontFamily: 'Playfair Display', fontWeight: 700, fill: '#ff0000' });
    expect(el(store, 'b')).toMatchObject({ fontFamily: 'Playfair Display' }); // second size -> subheading -> falls back to heading
    expect(store.getState().lastChange?.rebuildText.sort()).toEqual(['b', 'h']);
    a.undo();
    expect(el(store, 'h')).toMatchObject({ fontFamily: 'Inter' });
    a.removeBrandKit(k.id);
    expect(store.getState().activeBrandKitId).toBeNull();
  });

  it('inserts a logo (asset merged), applies colors and brand fonts', () => {
    const { store } = makeStore([text('t'), rect('r', 0, 0, 10, 10), rect('line', 0, 0, 10, 2)]);
    const a = store.getState().actions;
    const { kit: k, logo } = kit();
    a.upsertBrandKit(k);
    const id = a.insertBrandLogo(logo.id)!;
    const img = el(store, id) as ImageElement;
    expect(store.getState().document.assets[img.assetId]!.src).toBe('/uploads/logo.png');
    expect(store.getState().selectedIds).toEqual([id]);
    expect(page0(store).elements.at(-1)!.id).toBe(id);
    a.applyColor('#00FF00', { ids: ['t', 'r'] });
    expect(el(store, 't')).toMatchObject({ fill: '#00ff00' });
    expect(el(store, 'r')).toMatchObject({ fill: '#00ff00' });
    a.applyColor('#0000ff', { ids: ['r'], property: 'stroke' });
    expect(el(store, 'r')).toMatchObject({ stroke: '#0000ff' });
    a.applyBrandFont('body', { ids: ['t'] });
    expect(el(store, 't')).toMatchObject({ fontFamily: 'Lato', fontWeight: 400 });
    assertValidDocument(store.getState().document);
  });
});
