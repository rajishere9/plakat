import { describe, expect, it } from 'vitest';
import {
  addBrandColor,
  addBrandFont,
  addBrandLogo,
  applyBrandKit,
  BrandKitError,
  createBrandKit,
  documentColorsByUsage,
  loadBrandKit,
  removeBrandColor,
  removeBrandFont,
  removeBrandLogo,
  setBrandFont,
} from './brand.ts';
import { createDocument, createShapeElement, createTextElement } from './factory.ts';
import { getFontInfo, hasFontVariant, matchFontWeight, resolveFontVariant } from './font-catalog.ts';
import { fontLoadRequests, googleFontsCssUrl, googleFontVariantCssUrl, requestedFontVariants } from './fonts.ts';
import { loadDocument } from './load.ts';
import { DocumentSchema } from './validation.ts';
import { readExampleJson } from './test-utils.ts';

describe('brand kit helpers', () => {
  it('validates colors and fonts, one font per role', () => {
    expect(() => addBrandColor(createBrandKit(), 'red')).toThrow(BrandKitError);
    let kit = addBrandColor(createBrandKit(), '#FF0000');
    kit = removeBrandColor(kit, kit.colors[0]!.id);
    expect(kit.colors).toEqual([]);

    const h = addBrandFont(kit, { role: 'heading', family: 'Playfair Display', weight: 700 });
    kit = h.kit;
    expect(() => addBrandFont(kit, { role: 'heading', family: 'Inter' })).toThrow(/already has a heading font/);
    kit = setBrandFont(kit, { role: 'heading', family: 'Inter', weight: 800 }).kit;
    expect(kit.fonts).toEqual([{ id: h.font.id, role: 'heading', family: 'Inter', weight: 800, style: 'normal' }]);
    expect(() => setBrandFont(kit, { role: 'body', family: 'Bad"Font' })).toThrow(/Invalid font family/);
    expect(loadBrandKit(JSON.parse(JSON.stringify(kit)))).toEqual(kit);
    expect(() => loadBrandKit({ ...kit, fonts: [...kit.fonts, { ...kit.fonts[0]!, id: 'bf_two' }] })).toThrow(/Duplicate brand font role "heading"/);
    expect(removeBrandFont(kit, h.font.id).fonts).toEqual([]);
  });

  it('removes logos with their asset and validates logo assets', () => {
    const asset = { type: 'image' as const, mimeType: 'image/png' as const, width: 1, height: 1, src: '/l.png', name: '', source: null };
    const { kit, logo } = addBrandLogo(createBrandKit(), asset);
    const removed = removeBrandLogo(kit, logo.id);
    expect(removed.logos).toEqual([]);
    expect(removed.assets).toEqual({});
    expect(() => addBrandLogo(createBrandKit(), { ...asset, src: 'javascript:x' })).toThrow(BrandKitError);
    expect(() => loadBrandKit(JSON.parse(JSON.stringify(kit).replace('"assets":{', '"assets":{"__proto__":{},')))).toThrow(/Reserved key/);
  });
});

describe('applyBrandKit (no slots needed)', () => {
  it('maps colors by usage and fonts by size rank on a plain design', () => {
    const doc = createDocument();
    doc.pages[0]!.background.color = '#FFFFFF';
    doc.pages[0]!.elements.push(
      createShapeElement('rect', { fill: '#111111' }),
      createShapeElement('ellipse', { fill: '#111111', stroke: '#22222280' }),
      createTextElement({ fontSize: 80, fill: '#111111' }),
      createTextElement({ fontSize: 40, fill: '#333333' }),
      createTextElement({ fontSize: 20, fill: '#333333' }),
      createTextElement({ fontSize: 12, fill: '#ffffff' }),
    );
    expect(documentColorsByUsage(doc)).toEqual(['#111111', '#ffffff', '#333333', '#222222']);

    let kit = addBrandColor(addBrandColor(createBrandKit(), '#ff5e3a'), '#00000000');
    kit = setBrandFont(kit, { role: 'heading', family: 'Playfair Display', weight: 700 }).kit;
    kit = setBrandFont(kit, { role: 'body', family: 'Lato' }).kit;
    const out = applyBrandKit(doc, kit);
    expect(DocumentSchema.safeParse(out).success).toBe(true);
    const els = out.pages[0]!.elements as any[];
    expect(els[0].fill).toBe('#ff5e3a');
    expect(els[1].stroke).toBe('#22222280'); // 4th color: kit has only 2
    expect(out.pages[0]!.background.color).toBe('#00000000');
    expect(els[5].fill).toBe('#00000000');
    expect(els.slice(2).map((e) => e.fontFamily)).toEqual(['Playfair Display', 'Playfair Display', 'Lato', 'Lato']);
    expect(els[2].fontWeight).toBe(700);
    expect(out.fonts.map((f) => f.family)).toEqual(['Playfair Display', 'Lato']);
    expect(els.map((e) => e.id)).toEqual(doc.pages[0]!.elements.map((e) => e.id));
    // opt-outs
    expect(applyBrandKit(doc, kit, { colors: false, fonts: false }).pages).toEqual(doc.pages);
  });

  it('keeps per-color alpha when replacing', () => {
    const doc = createDocument();
    doc.pages[0]!.background.color = null;
    doc.pages[0]!.elements.push(createShapeElement('rect', { fill: '#11111180' }));
    const out = applyBrandKit(doc, addBrandColor(createBrandKit(), '#abcdef'));
    expect((out.pages[0]!.elements[0] as any).fill).toBe('#abcdef80');
  });
});

describe('Google Fonts variant resolution', () => {
  it('matches weights like CSS and never requests missing variants for catalogued families', () => {
    expect(matchFontWeight(700, [400])).toBe(400);
    expect(matchFontWeight(500, [300, 400, 700])).toBe(400);
    expect(matchFontWeight(400, [300, 500, 700])).toBe(500);
    expect(matchFontWeight(300, [100, 400])).toBe(100);
    expect(matchFontWeight(600, [400, 800])).toBe(800);
    expect(resolveFontVariant('Lobster', 700, 'italic')).toEqual({ weight: 400, style: 'normal' });
    expect(resolveFontVariant('lobster', 400, 'normal')).toEqual({ weight: 400, style: 'normal' });
    expect(resolveFontVariant('Libre Baskerville', 700, 'italic')).toEqual({ weight: 400, style: 'italic' });
    expect(resolveFontVariant('Some Uncatalogued', 700, 'italic')).toEqual({ weight: 700, style: 'italic' });
    expect(hasFontVariant('Lobster', 700, 'normal')).toBe(false);
    expect(getFontInfo('Inter')?.normal).toContain(900);

    expect(googleFontsCssUrl({ family: 'Lobster', variants: [{ weight: 700, style: 'normal' }, { weight: 400, style: 'italic' }] })).toBe(
      'https://fonts.googleapis.com/css2?family=Lobster:wght@400&display=block',
    );
    expect(requestedFontVariants({ family: 'Oswald', variants: [{ weight: 900, style: 'italic' }] })).toEqual([{ weight: 700, style: 'normal' }]);
    expect(googleFontVariantCssUrl('Some Font', { weight: 300, style: 'italic' })).toBe(
      'https://fonts.googleapis.com/css2?family=Some+Font:ital,wght@1,300&display=block',
    );
  });
});

describe('text-aware font readiness requests', () => {
  it('carries the rendered characters so non-latin subsets load', () => {
    const doc = loadDocument(readExampleJson());
    const reqs = fontLoadRequests(doc);
    expect(reqs.map((r) => [r.family, r.weight, r.style])).toEqual([
      ['Inter', 400, 'normal'],
      ['Inter', 800, 'normal'],
      ['Playfair Display', 700, 'italic'],
    ]);
    // textTransform applied (uppercase details line), space always present, sorted, unique
    expect(reqs[0]!.text).toBe(' .ACDEHIKLMNOPSTWXY·');
    expect(reqs[2]!.text).toBe(' Saelmrsu');

    const pl = createDocument();
    pl.pages[0]!.elements.push(
      createTextElement({ content: 'Zażółć gęślą\njaźń', fontFamily: 'Inter' }),
      createTextElement({ content: 'Привет', fontFamily: 'Inter', hidden: true }),
    );
    const [r] = fontLoadRequests(pl);
    expect(r!.text).toContain('ż');
    expect(r!.text).toContain('П'); // hidden elements included
    expect(r!.text).not.toContain('\n');
    expect(fontLoadRequests(pl, { pageIds: ['pg_none'] })).toEqual([]);
  });
});
