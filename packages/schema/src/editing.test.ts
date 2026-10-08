import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { getBrandLogoAsset, addBrandLogo, createBrandKit } from './brand.ts';
import {
  centerOnPage,
  cloneElementsWithNewIds,
  clonePageWithNewIds,
  cloneWithNewIds,
  createDocument,
  createImageAsset,
  createImageElement,
  createShapeElement,
  createTextElement,
  DEFAULT_SHAPE_SIDES,
  importElements,
  importPages,
  mergeAssets,
  normalizeDocument,
  removeElements,
  removePage,
} from './factory.ts';
import { getElementBounds } from './geometry.ts';
import { DocumentValidationError, loadDocument } from './load.ts';
import { presetToPageSize } from './presets.ts';
import { serializeDocument } from './portable.ts';
import {
  addSlot,
  applySlotFill,
  convertToTemplate,
  instantiateTemplate,
  moveSlot,
  removeSlot,
  saveAsTemplate,
  setSlotTargets,
  TemplateError,
  updateSlot,
} from './templates.ts';
import type { PlakatDocument } from './types.ts';
import { DocumentSchema, ShapeElementSchema } from './validation.ts';
import { readExampleJson } from './test-utils.ts';

const template = (): PlakatDocument => loadDocument(readExampleJson());
const valid = (doc: unknown) => {
  const r = DocumentSchema.safeParse(doc);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return true;
};

describe('id namespaces', () => {
  it('validation requires ids unique across pages, elements, slots and groups', () => {
    const slotLikeElement = readExampleJson() as any;
    slotLikeElement.template.slots[0].id = 'el_headline';
    expect(() => loadDocument(slotLikeElement)).toThrow(/Duplicate id "el_headline" \(already used by an element\)/);
    const groupLikeElement = readExampleJson() as any;
    groupLikeElement.pages[0].elements[2].groupId = 'el_badgeText';
    groupLikeElement.pages[0].elements[3].groupId = 'el_badgeText';
    expect(() => loadDocument(groupLikeElement)).toThrow(/Group id "el_badgeText" collides with an element id/);
  });

  it('cloneWithNewIds keeps namespaces apart even for unvalidated input', () => {
    // build colliding ids directly (bypassing validation, as an in-memory editor state could)
    const t = template();
    const slots = t.template!.slots.map((s, i) => (i === 1 ? { ...s, id: 'el_headline' } : s));
    const els = t.pages[0]!.elements.map((e) => (e.groupId ? { ...e, groupId: 'el_badgeText' } : e));
    const colliding: PlakatDocument = { ...t, pages: [{ ...t.pages[0]!, elements: els }], template: { ...t.template!, slots } };
    const { document, ids } = cloneWithNewIds(colliding);
    expect(valid(document)).toBe(true);
    expect(document.template!.slots[1]!.targets).toEqual([ids.elements.get('el_headline')]);
    const [badge, label] = [document.pages[0]!.elements[2]!, document.pages[0]!.elements[3]!];
    expect(badge.groupId).toBe(label.groupId);
    expect(badge.groupId).toBe(ids.groups.get('el_badgeText'));
  });
});

describe('clone helpers inside immer', () => {
  it('work on drafts', () => {
    const doc = template();
    const next = produce(doc, (d) => {
      d.pages.push(clonePageWithNewIds(d.pages[0]!));
      d.pages[0]!.elements.push(...cloneElementsWithNewIds([d.pages[0]!.elements[1]!]));
    });
    expect(next.pages).toHaveLength(2);
    expect(next.pages[0]!.elements).toHaveLength(7);
    expect(valid(next)).toBe(true);
    const cloned = produce(doc, (d) => {
      d.meta.title = cloneWithNewIds(d as PlakatDocument).document.meta.title + ' copy';
    });
    expect(cloned.meta.title).toBe('Summer sale — Instagram post copy');
  });

  it('applySlotFill and getBrandLogoAsset accept draft inputs', () => {
    const t = template();
    const { asset } = createImageAsset({ src: '/x.png', width: 2, height: 2, mimeType: 'image/png' });
    const out = produce({ t, asset }, (d) => {
      d.t = applySlotFill(d.t as PlakatDocument, 'slot_photo', { assetId: 'as_x', asset: d.asset }) as never;
    });
    expect(out.t.assets['as_x']!.src).toBe('/x.png');
    const { kit, logo } = addBrandLogo(createBrandKit(), asset);
    const res = produce({ kit, got: null as unknown }, (d) => {
      d.got = getBrandLogoAsset(d.kit as never, logo.id);
    });
    expect((res.got as { asset: { src: string } }).asset.src).toBe('/x.png');
  });
});

describe('importing content between documents', () => {
  it('mergeAssets keeps, dedupes or renames colliding ids', () => {
    const a = createImageAsset({ src: '/a.png', width: 1, height: 1, mimeType: 'image/png' }).asset;
    const b = createImageAsset({ src: '/b.png', width: 1, height: 1, mimeType: 'image/png' }).asset;
    const r = mergeAssets({ as_logo: a, as_other: b }, { as_logo: b, as_new: a, as_other: b });
    expect(r.assets['as_logo']).toEqual(a); // never clobbered
    expect(r.assetIdMap.get('as_logo')).toBe('as_other'); // reuses the equal record
    expect(r.assets['as_new']).toEqual(a); // free id kept
    expect(r.assetIdMap.has('as_other')).toBe(false); // deep-equal kept
    const r2 = mergeAssets({ as_logo: a }, { as_logo: b });
    expect(r2.assetIdMap.get('as_logo')).toMatch(/^as_/);
    expect(r2.assets[r2.assetIdMap.get('as_logo')!]).toEqual(b);
  });

  it('importPages adds a template page without swapping the design images', () => {
    const design = createDocument('instagram-post');
    design.assets['as_placeholder'] = createImageAsset({ src: '/mine.png', width: 4, height: 3, mimeType: 'image/png' }).asset;
    design.pages[0]!.elements.push(createImageElement('as_placeholder', design.assets['as_placeholder']!));
    const t = template();
    const { document, pageIds } = importPages(design, t);
    expect(valid(document)).toBe(true);
    expect(document.pages).toHaveLength(2);
    expect(document.pages[1]!.id).toBe(pageIds[0]);
    expect(document.assets['as_placeholder']!.src).toBe('/mine.png');
    const imported = document.pages[1]!.elements[0] as { assetId: string };
    expect(imported.assetId).not.toBe('as_placeholder');
    expect(document.assets[imported.assetId]).toEqual(t.assets['as_placeholder']);
    expect(document.fonts.map((f) => f.family)).toEqual(['Inter', 'Playfair Display']);
    // insert position
    expect(importPages(design, t, { index: 0 }).document.pages[0]!.name).toBe('Cover');
  });

  it('importElements pastes and inserts brand logos without clobbering', () => {
    const design = createDocument();
    const mine = createImageAsset({ src: '/mine.png', width: 10, height: 10, mimeType: 'image/png' });
    const { kit, logo } = addBrandLogo(createBrandKit(), createImageAsset({ src: '/logo.svg', width: 10, height: 10, mimeType: 'image/svg+xml' }).asset);
    const resolved = getBrandLogoAsset(kit, logo.id)!;
    design.assets[resolved.assetId] = mine.asset; // same id, different image
    design.pages[0]!.elements.push(createImageElement(resolved.assetId, mine.asset));
    const { document, elementIds } = importElements(design, design.pages[0]!.id, {
      elements: [createImageElement(resolved.assetId, resolved.asset)],
      assets: { [resolved.assetId]: resolved.asset },
    });
    expect(valid(document)).toBe(true);
    const inserted = document.pages[0]!.elements.find((e) => e.id === elementIds[0]) as { assetId: string };
    expect(document.assets[inserted.assetId]!.src).toBe('/logo.svg');
    expect(document.assets[resolved.assetId]!.src).toBe('/mine.png');
    expect(() => importElements(design, 'pg_nope', { elements: [], assets: {} })).toThrow(/Unknown page/);
  });
});

describe('deleting keeps templates saveable', () => {
  it('removeElements prunes slot targets and empty slots', () => {
    const t = template();
    const out = removeElements(t, ['el_headline', 'el_band']);
    expect(out.template!.slots.map((s) => s.id)).toEqual(['slot_photo', 'slot_details']);
    expect(() => serializeDocument(out)).not.toThrow();
    const multi = { ...t, template: { ...t.template!, slots: [{ ...t.template!.slots[3]!, targets: ['el_band', 'el_badge'] }] } } as PlakatDocument;
    expect(removeElements(multi, ['el_band']).template!.slots[0]!.targets).toEqual(['el_badge']);
  });

  it('removePage prunes slots and refuses to remove the last page', () => {
    const t = template();
    expect(() => removePage(t, t.pages[0]!.id)).toThrow(/at least one page/);
    const two = importPages(t, createDocument());
    const out = removePage({ ...two.document }, 'pg_cover');
    expect(out.template!.slots).toEqual([]);
    expect(valid(out)).toBe(true);
  });

  it('normalizeDocument (and so serializeDocument) prunes dangling targets of a raw splice', () => {
    const t = template();
    const spliced = produce(t, (d) => {
      d.pages[0]!.elements.splice(4, 1); // el_headline, Delete key in immer
    });
    expect(() => serializeDocument(spliced)).not.toThrow();
    expect(normalizeDocument(spliced).template!.slots.some((s) => s.id === 'slot_headline')).toBe(false);
  });
});

describe('id-preserving slot authoring', () => {
  it('converts in place and edits slots without touching ids', () => {
    const design = createDocument();
    const title = createTextElement({ content: 'Title' });
    const box = createShapeElement('rect');
    design.pages[0]!.elements.push(title, box);
    expect(() => addSlot(design, title.id)).toThrow(/only be edited on a template/);

    let t = convertToTemplate(design, { category: 'promo' });
    expect(t.id).toBe(design.id);
    expect(t.kind).toBe('template');
    const added = addSlot(t, title.id);
    t = added.document;
    expect(t.template!.slots[0]).toMatchObject({ kind: 'text', targets: [title.id], label: 'Title' });
    t = addSlot(t, { kind: 'color', targets: [box.id, title.id], label: 'Accent' }).document;
    t = updateSlot(t, added.slot.id, { maxLength: 20, multiline: false, label: 'Headline' });
    expect(t.template!.slots[0]).toMatchObject({ maxLength: 20, multiline: false, label: 'Headline' });
    expect(() => updateSlot(t, added.slot.id, { fit: 'contain' } as never)).toThrow(/does not exist on a text slot/);
    const colorId = t.template!.slots[1]!.id;
    expect(() => updateSlot(t, colorId, { property: 'stroke' })).toThrow(/cannot target a text element/);
    t = setSlotTargets(t, colorId, [box.id]);
    t = updateSlot(t, colorId, { property: 'stroke' });
    expect(() => setSlotTargets(t, colorId, [])).toThrow(/at least one target/);
    t = moveSlot(t, colorId, 0);
    expect(t.template!.slots.map((s) => s.kind)).toEqual(['color', 'text']);
    t = removeSlot(t, colorId);
    expect(t.template!.slots).toHaveLength(1);
    expect(t.pages[0]!.elements.map((e) => e.id)).toEqual([title.id, box.id]);
    expect(valid(t)).toBe(true);
    expect(() => removeSlot(t, 'slot_nope')).toThrow(TemplateError);
    // still instantiable
    expect((instantiateTemplate(t, { [t.template!.slots[0]!.id]: { text: 'Hi' } }).pages[0]!.elements[0] as { content: string }).content).toBe('Hi');
  });

  it('saveAsTemplate still validates and regenerates ids', () => {
    const t = template();
    const copy = saveAsTemplate(t, ['el_headline']);
    expect(copy.id).not.toBe(t.id);
    expect(copy.template!.slots).toHaveLength(1);
    expect(() => saveAsTemplate(t, [{ kind: 'text', targets: ['el_band'] }])).toThrow(/cannot target a shape/);
  });
});

describe('factory defaults', () => {
  it('scale to the page and agree with the schema', () => {
    const card = presetToPageSize('business-card'); // 336 x 192
    const text = createTextElement({}, { page: card });
    expect(text.width).toBeLessThanOrEqual(card.width);
    expect(text.fontSize).toBe(12);
    const rect = createShapeElement('rect', {}, { page: card });
    expect(rect.height).toBeLessThan(card.height);
    const story = presetToPageSize('instagram-story');
    expect(createTextElement({}, { page: story }).fontSize).toBe(65);
    const img = createImageElement('as_x', { width: 4000, height: 2000 }, {}, { page: card });
    expect(img.width).toBeCloseTo(192 * 0.6, 9);
    expect(createShapeElement('polygon').sides).toBe(DEFAULT_SHAPE_SIDES);
    expect(ShapeElementSchema.parse({ id: 'el_p', type: 'shape', shape: 'polygon', x: 0, y: 0, width: 1, height: 1 }).sides).toBe(DEFAULT_SHAPE_SIDES);
    // no page: legacy fixed defaults
    expect(createTextElement().fontSize).toBe(32);
  });

  it('centerOnPage keeps rotation and centers the rotated bounds', () => {
    const el = createShapeElement('rect', { width: 200, height: 50, rotation: 30 });
    const c = centerOnPage(el, { width: 1000, height: 600 });
    expect(c.rotation).toBe(30);
    const b = getElementBounds(c);
    expect(b.x + b.width / 2).toBeCloseTo(500, 9);
    expect(b.y + b.height / 2).toBeCloseTo(300, 9);
  });
});

describe('DocumentValidationError surfaces', () => {
  it('is thrown for documents that serialize invalid', () => {
    const doc = createDocument();
    (doc.pages[0]!.elements as unknown[]).push({ id: 'el_x', type: 'text' });
    expect(() => serializeDocument(doc)).toThrow(DocumentValidationError);
  });
});
