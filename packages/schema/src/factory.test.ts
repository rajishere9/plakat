import { describe, expect, it } from 'vitest';
import { addBrandColor, addBrandLogo, createBrandKit, getBrandLogoAsset, loadBrandKit } from './brand.ts';
import {
  cloneElementsWithNewIds,
  cloneWithNewIds,
  createDocument,
  createImageAsset,
  createImageElement,
  createShapeElement,
  createTextElement,
  pruneUnusedAssets,
} from './factory.ts';
import { applyTextTransform, collectFonts, fontLoadRequests, googleFontsCssUrl } from './fonts.ts';
import { ID_PATTERN } from './ids.ts';
import { loadDocument } from './load.ts';
import { customPageSize, PAGE_PRESETS } from './presets.ts';
import { DocumentSchema } from './validation.ts';
import { UnsupportedSchemaVersionError } from './version.ts';
import { FIXED_NOW, readExampleJson } from './test-utils.ts';

describe('factory', () => {
  it('creates valid documents for every preset and custom sizes', () => {
    for (const p of PAGE_PRESETS) {
      const doc = createDocument(p.id, { now: FIXED_NOW });
      expect(DocumentSchema.safeParse(doc).success).toBe(true);
      expect(doc.size.presetId).toBe(p.id);
      expect(doc.meta.createdAt).toBe('2026-10-08T12:00:00.000Z');
    }
    expect(createDocument(customPageSize(100, 50, 'mm')).size.width).toBeCloseTo(377.95, 2);
    expect(createDocument('instagram-post', { kind: 'template' }).template).toEqual({ category: null, slots: [] });
  });

  it('creates valid elements of every type', () => {
    const doc = createDocument();
    const { id, asset } = createImageAsset({ src: 'https://x.test/a.png', width: 1200, height: 600, mimeType: 'image/png' });
    doc.assets[id] = asset;
    const img = createImageElement(id, asset);
    expect([img.width, img.height]).toEqual([600, 300]);
    doc.pages[0]!.elements.push(
      createTextElement({ content: 'Hello', fontSize: 40 }),
      ...(['rect', 'ellipse', 'line', 'triangle', 'polygon', 'star'] as const).map((s) => createShapeElement(s)),
      img,
    );
    expect(DocumentSchema.safeParse(doc).success).toBe(true);
    for (const el of doc.pages[0]!.elements) expect(el.id).toMatch(ID_PATTERN);
  });

  it('cloneWithNewIds regenerates ids, remaps slots & groups, keeps assets', () => {
    const t = loadDocument(readExampleJson());
    const { document, ids } = cloneWithNewIds(t);
    expect(DocumentSchema.safeParse(document).success).toBe(true);
    expect(document.id).not.toBe('doc_summerSale01');
    expect(document.template!.slots[1]!.targets).toEqual([ids.elements.get('el_headline')]);
    expect(ids.slots.get('slot_headline')).toBe(document.template!.slots[1]!.id);
    expect(ids.pages.get('pg_cover')).toBe(document.pages[0]!.id);
    expect(document.assets).toEqual(t.assets);
    expect(ids.groups.get('grp_badge')).toMatch(/^grp_/);
    const els = cloneElementsWithNewIds(t.pages[0]!.elements);
    expect(els[2]!.groupId).toBe(els[3]!.groupId);
    expect(els[2]!.groupId).not.toBe('grp_badge');
  });

  it('pruneUnusedAssets drops unreferenced registry entries', () => {
    const t = loadDocument(readExampleJson());
    t.assets['as_orphan'] = t.assets['as_placeholder']!;
    expect(Object.keys(pruneUnusedAssets(t).assets)).toEqual(['as_placeholder']);
  });
});

describe('fonts', () => {
  it('collects exact variants and builds per-family Google Fonts URLs', () => {
    const doc = loadDocument(readExampleJson());
    expect(collectFonts(doc)).toEqual(doc.fonts);
    expect(googleFontsCssUrl(doc.fonts[0]!)).toBe('https://fonts.googleapis.com/css2?family=Inter:wght@400;800&display=block');
    expect(googleFontsCssUrl(doc.fonts[1]!)).toBe(
      'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,700&display=block',
    );
    expect(fontLoadRequests(doc).map((r) => r.query)).toEqual([
      'normal 400 16px "Inter"',
      'normal 800 16px "Inter"',
      'italic 700 16px "Playfair Display"',
    ]);
  });

  it('applies text transforms deterministically', () => {
    expect(applyTextTransform('hello wörld', 'uppercase')).toBe('HELLO WÖRLD');
    expect(applyTextTransform('hello wörld\nnew line', 'capitalize')).toBe('Hello Wörld\nNew Line');
    expect(applyTextTransform('ABC', 'lowercase')).toBe('abc');
    expect(applyTextTransform('As Is', 'none')).toBe('As Is');
  });
});

describe('brand kit', () => {
  it('creates, validates and resolves logos', () => {
    let kit = addBrandColor(createBrandKit('Acme'), '#FF5E3A', 'Primary');
    const { kit: withLogo, logo } = addBrandLogo(kit, { type: 'image', mimeType: 'image/svg+xml', width: 64, height: 64, src: 'data:image/svg+xml,%3Csvg%2F%3E', name: 'Logo', source: null });
    kit = withLogo;
    expect(loadBrandKit(JSON.parse(JSON.stringify(kit)))).toEqual(kit);
    expect(kit.colors[0]!.value).toBe('#ff5e3a');
    expect(getBrandLogoAsset(kit, logo.id)!.asset.mimeType).toBe('image/svg+xml');
    expect(getBrandLogoAsset(kit, 'bl_nope')).toBeNull();
    expect(() => loadBrandKit({ ...kit, schemaVersion: 2 })).toThrow(UnsupportedSchemaVersionError);
    expect(() => loadBrandKit({ ...kit, logos: [{ id: 'bl_x', name: '', assetId: 'as_missing' }] })).toThrow(/Unknown asset/);
    expect(() => loadBrandKit({ ...kit, format: 'plakat.document' })).toThrow(/Not a Plakat brand kit/);
  });
});
