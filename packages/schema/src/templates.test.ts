import { describe, expect, it } from 'vitest';
import { createDocument, createShapeElement, createTextElement, createImageElement, createImageAsset } from './factory.ts';
import { loadDocument } from './load.ts';
import { applySlotFill, instantiateTemplate, listSlots, saveAsTemplate, slotsByElement, TemplateError } from './templates.ts';
import { DocumentSchema } from './validation.ts';
import { FIXED_NOW, readExampleJson } from './test-utils.ts';
import type { PlakatDocument, TextElement } from './types.ts';

const template = (): PlakatDocument => loadDocument(readExampleJson());

function allIds(doc: PlakatDocument): string[] {
  return [doc.id, ...doc.pages.flatMap((p) => [p.id, ...p.elements.map((e) => e.id)])];
}

describe('listSlots', () => {
  it('resolves targets and current values', () => {
    const slots = listSlots(template());
    expect(slots.map((s) => [s.slot.id, s.value])).toEqual([
      ['slot_photo', 'as_placeholder'],
      ['slot_headline', 'Summer sale'],
      ['slot_details', 'This weekend only · shop.example.com'],
      ['slot_accent', '#ff5e3a'],
    ]);
    expect(slots[0]!.targets[0]!.pageId).toBe('pg_cover');
    expect(slotsByElement(template()).get('el_band')!.map((s) => s.id)).toEqual(['slot_accent']);
  });
});

describe('instantiateTemplate', () => {
  it('fills slots, regenerates every id and yields a valid design', () => {
    const t = template();
    const { id: newAssetId, asset } = createImageAsset({ src: 'https://images.example/beach.jpg', width: 1600, height: 900, mimeType: 'image/jpeg' });
    const design = instantiateTemplate(
      t,
      {
        slot_headline: { text: 'Winter sale' },
        slot_photo: { assetId: newAssetId, asset },
        slot_accent: { color: '#007aff' },
      },
      { now: FIXED_NOW, title: 'My sale' },
    );

    expect(DocumentSchema.safeParse(design).success).toBe(true);
    expect(design.kind).toBe('design');
    expect(design.template).toBeNull();
    expect(design.meta).toMatchObject({ title: 'My sale', sourceTemplateId: 'doc_summerSale01', createdAt: '2026-10-08T12:00:00.000Z' });

    // fresh ids everywhere, structure preserved
    const oldIds = new Set(allIds(t));
    for (const id of allIds(design)) expect(oldIds.has(id)).toBe(false);
    expect(new Set(allIds(design)).size).toBe(allIds(design).length);
    const els = design.pages[0]!.elements;
    expect(els.map((e) => e.name)).toEqual(t.pages[0]!.elements.map((e) => e.name));

    // group membership preserved under a new group id
    const badge = els.filter((e) => e.name.startsWith('Badge'));
    expect(badge[0]!.groupId).not.toBe('grp_badge');
    expect(badge[0]!.groupId).toBe(badge[1]!.groupId);

    // fills applied
    expect((els[4] as TextElement).content).toBe('Winter sale');
    expect(els[1]).toMatchObject({ fill: '#007aff' });
    expect(els[0]).toMatchObject({ assetId: newAssetId, crop: null, objectFit: 'cover' });
    // unfilled slot keeps the template's placeholder
    expect((els[5] as TextElement).content).toBe('This weekend only · shop.example.com');
    // placeholder asset pruned, new one registered
    expect(Object.keys(design.assets)).toEqual([newAssetId]);
    // template untouched
    expect((t.pages[0]!.elements[4] as TextElement).content).toBe('Summer sale');
  });

  it('validates fills against slot constraints', () => {
    const t = template();
    expect(() => instantiateTemplate(t, { slot_headline: { text: 'x'.repeat(25) } })).toThrow(/at most 24 characters/);
    expect(() => instantiateTemplate(t, { slot_headline: { text: 'a\nb' } })).toThrow(/line breaks/);
    expect(() => instantiateTemplate(t, { slot_headline: { color: '#000000' } })).toThrow(/expects a text fill/);
    expect(() => instantiateTemplate(t, { slot_accent: { color: 'blue' } })).toThrow(/invalid color/);
    expect(() => instantiateTemplate(t, { slot_photo: { assetId: 'as_missing' } })).toThrow(/not in the registry/);
    expect(() => instantiateTemplate(t, { slot_nope: { text: 'x' } })).toThrow(TemplateError);
    expect(() => instantiateTemplate(t, {}, { enforceRequired: true })).toThrow(/Missing required slots: Hero photo, Headline/);
    expect(() => instantiateTemplate(createDocument())).toThrow(/requires a document with kind "template"/);
  });

  it('applySlotFill writes every target of a multi-target slot', () => {
    let t = template();
    t = { ...t, template: { ...t.template!, slots: [{ ...t.template!.slots[3]!, targets: ['el_band', 'el_badge'] } as never] } };
    const filled = applySlotFill(t, 'slot_accent', { color: '#34c759' });
    expect(filled.pages[0]!.elements.filter((e) => e.type === 'shape').map((e) => (e as { fill: string }).fill)).toEqual(['#34c759', '#34c759']);
  });
});

describe('saveAsTemplate', () => {
  it('turns any design into a template with inferred slots and fresh ids', () => {
    const design = createDocument('instagram-story', { title: 'Promo' });
    const { id: assetId, asset } = createImageAsset({ src: 'data:image/png;base64,AAAA', width: 10, height: 10, mimeType: 'image/png' });
    design.assets[assetId] = asset;
    const title = createTextElement({ content: 'Big announcement' });
    const photo = createImageElement(assetId, asset);
    const outline = createShapeElement('rect', { fill: null, stroke: '#ff0000', strokeWidth: 2 });
    design.pages[0]!.elements.push(title, photo, outline);

    const t = saveAsTemplate(
      design,
      [title.id, photo.id, outline.id, { kind: 'text', targets: [title.id], label: 'Short title', maxLength: 10, multiline: false }],
      { now: FIXED_NOW, category: 'promo' },
    );
    expect(t.kind).toBe('template');
    expect(t.id).not.toBe(design.id);
    expect(t.template!.category).toBe('promo');
    const slots = t.template!.slots;
    expect(slots.map((s) => s.kind)).toEqual(['text', 'image', 'color', 'text']);
    expect(slots.map((s) => s.label)).toEqual(['Big announcement', 'Image', 'Color', 'Short title']);
    expect(slots[2]).toMatchObject({ property: 'stroke' });
    // targets remapped to the template's new element ids
    const newIds = t.pages[0]!.elements.map((e) => e.id);
    expect(newIds).not.toContain(title.id);
    expect(slots[0]!.targets).toEqual([newIds[0]]);
    expect(slots[3]!.targets).toEqual([newIds[0]]);

    // and it can be instantiated straight away
    const again = instantiateTemplate(t, { [slots[3]!.id]: { text: 'Hello' } });
    expect((again.pages[0]!.elements[0] as TextElement).content).toBe('Hello');
  });

  it('rejects unknown elements and incompatible explicit specs', () => {
    const design = createDocument();
    const text = createTextElement();
    design.pages[0]!.elements.push(text);
    expect(() => saveAsTemplate(design, ['el_nope'])).toThrow(/not found/);
    expect(() => saveAsTemplate(design, [{ kind: 'image', targets: [text.id] }])).toThrow(/cannot target a text element/);
  });
});
