/**
 * PageScene structure (§2.2), element mapping (§3.3, §3.4), reconciliation, the readiness
 * barrier errors (§3.1, §3.2) and the editor helpers.
 */
import { createTestEnv, editElement, editPage, image, makeDoc, page, rgba, shape, text, FIXTURE_FAMILY } from './test-support.ts';
import { describe, expect, it } from 'vitest';
import { customPageSize, exportPixelSize, presetToPageSize, type PlakatDocument } from '@plakat/schema';
import { fixtureAssets } from './fixture-docs.ts';
import { Konva, type KonvaGroup, type KonvaShape, type KonvaText } from './konva.ts';
import { prepareResources } from './resources.ts';
import { rasterizePage } from './rasterize.ts';
import {
  ASSET_PLACEHOLDER_NAME,
  ELEMENT_NODE_NAME,
  PAGE_BACKGROUND_NAME,
  PAGE_CONTENT_NAME,
  PageScene,
} from './scene.ts';
import { createPageFrame, getElementIdFromNode, getPageIdFromNode, mountPageScene } from './editor.ts';
import { AssetLoadError, FontLoadError } from './errors.ts';
import { createEmptyResources } from './types.ts';
import { createNodeEnv } from './env-node.ts';

const env = createTestEnv();

function textNode(scene: PageScene, id: string): KonvaText {
  const n = scene.getElementNode(id)!.getChildren()[1];
  if (!(n instanceof Konva.Text)) throw new Error('not text');
  return n;
}

async function sceneFor(doc: PlakatDocument, pixelRatio = 1, pageId = doc.pages[0]!.id) {
  const resources = await prepareResources(doc, undefined, env);
  return { scene: new PageScene({ doc, pageId, resources, pixelRatio }), resources };
}

describe('page root & content group (§2.2)', () => {
  it('root at origin, content scaled by contentScale and clipped to the page', async () => {
    const doc = makeDoc('a4-poster', [page('pg_1', [shape('el_r', 'rect')])]);
    const { scene } = await sceneFor(doc, 1);
    expect(scene.root.position()).toEqual({ x: 0, y: 0 });
    expect(scene.root.scale()).toEqual({ x: 1, y: 1 });
    expect(scene.root.opacity()).toBe(1);
    const content = scene.root.getChildren()[0] as KonvaGroup;
    expect(scene.root.getChildren()).toHaveLength(1);
    expect(content.name()).toBe(PAGE_CONTENT_NAME);
    const px = exportPixelSize(doc.size, 1);
    expect(content.scaleX()).toBe(px.contentScaleX);
    expect(content.scaleY()).toBe(px.contentScaleY);
    expect(content.clip()).toEqual({ x: 0, y: 0, width: doc.size.width, height: doc.size.height });
    const bg = content.getChildren()[0] as KonvaShape;
    expect(bg.name()).toBe(PAGE_BACKGROUND_NAME);
    expect([bg.width(), bg.height()]).toEqual([doc.size.width, doc.size.height]);
    scene.setPixelRatio(3.125);
    expect(content.scaleX()).toBe(exportPixelSize(doc.size, 3.125).contentScaleX);
    expect(content.clip()).toEqual({ x: 0, y: 0, width: doc.size.width, height: doc.size.height });
    scene.destroy();
  });

  it('one top-level node per element: Group with id, name "element", unit scale, no offset', async () => {
    const doc = makeDoc(customPageSize(500, 500), [
      page('pg_1', [shape('el_a', 'rect', { rotation: 30, opacity: 0.5 }), text('el_b', { content: 'Hi', hidden: true })]),
    ]);
    const { scene } = await sceneFor(doc);
    const a = scene.getElementNode('el_a')!;
    expect(a).toBeInstanceOf(Konva.Group);
    expect(a.id()).toBe('el_a');
    expect(a.name()).toBe(ELEMENT_NODE_NAME);
    expect([a.x(), a.y(), a.rotation(), a.opacity(), a.scaleX(), a.scaleY(), a.offsetX(), a.offsetY()]).toEqual([40, 40, 30, 0.5, 1, 1, 0, 0]);
    expect(scene.getElementNode('el_b')!.visible()).toBe(false);
    expect(scene.getElementIds()).toEqual(['el_a', 'el_b']);
    scene.destroy();
  });
});

describe('text mapping (§3.3, P-5)', () => {
  it('maps font, transform, letterSpacing (em → px), decoration; no fixed height', async () => {
    const doc = makeDoc(customPageSize(800, 800), [
      page('pg_1', [
        text('el_t', {
          content: 'hello world',
          textTransform: 'uppercase',
          fontWeight: 700,
          fontStyle: 'italic',
          fontSize: 40,
          letterSpacing: 0.05,
          textDecoration: 'none',
          align: 'center',
        }),
      ]),
    ]);
    const { scene } = await sceneFor(doc);
    const t = textNode(scene, 'el_t');
    expect(t.text()).toBe('HELLO WORLD');
    expect(t.fontFamily()).toBe(FIXTURE_FAMILY);
    expect(t.fontStyle()).toBe('italic 700');
    expect(t.fontSize()).toBe(40);
    expect(t.letterSpacing()).toBeCloseTo(2, 12);
    expect(t.textDecoration()).toBe('');
    expect(t.align()).toBe('center');
    expect(t.wrap()).toBe('word');
    expect(t.attrs.height).toBeUndefined();
    scene.destroy();
  });

  it('computes vertical alignment; overflowing text starts at the top and is never clipped', async () => {
    const doc = makeDoc(customPageSize(800, 800), [
      page('pg_1', [
        text('el_top', { content: 'One line', height: 200, verticalAlign: 'top' }),
        text('el_mid', { content: 'One line', height: 200, verticalAlign: 'middle' }),
        text('el_bot', { content: 'One line', height: 200, verticalAlign: 'bottom' }),
        text('el_over', { content: 'a\nb\nc\nd\ne', height: 20, verticalAlign: 'bottom' }),
      ]),
    ]);
    const { scene } = await sceneFor(doc);
    const h = textNode(scene, 'el_top').height();
    expect(h).toBeCloseTo(32 * 1.2, 9);
    expect(textNode(scene, 'el_top').y()).toBe(0);
    expect(textNode(scene, 'el_mid').y()).toBeCloseTo((200 - h) / 2, 9);
    expect(textNode(scene, 'el_bot').y()).toBeCloseTo(200 - h, 9);
    const over = textNode(scene, 'el_over');
    expect(over.y()).toBe(0);
    expect(over.textArr.map((l) => l.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
    scene.destroy();
  });

  it('narrow boxes (width 0, narrower than a glyph) keep every character (D-9)', async () => {
    const content = 'Wide MMM text';
    const doc = makeDoc(customPageSize(800, 800), [
      page('pg_1', [text('el_0', { content, width: 0 }), text('el_5', { content, width: 5, letterSpacing: 0.3 })]),
    ]);
    const { scene } = await sceneFor(doc);
    for (const id of ['el_0', 'el_5']) {
      const t = textNode(scene, id);
      expect(t.width()).toBeGreaterThanOrEqual(t.measureSize('W').width);
      expect(t.textArr.map((l) => l.text).join('').replace(/\s/g, '')).toBe(content.replace(/\s/g, ''));
    }
    scene.destroy();
  });

  it('wide-enough boxes keep the element width', async () => {
    const doc = makeDoc(customPageSize(800, 800), [page('pg_1', [text('el_t', { content: 'Short', width: 321.5 })])]);
    const { scene } = await sceneFor(doc);
    expect(textNode(scene, 'el_t').width()).toBe(321.5);
    scene.destroy();
  });
});

describe('shape mapping (§3.4)', () => {
  it('rect / ellipse / line / polygonal shapes', async () => {
    const doc = makeDoc(customPageSize(800, 800), [
      page('pg_1', [
        shape('el_rect', 'rect', { cornerRadius: 9, stroke: '#000000', strokeWidth: 2, dash: [4, 2] }),
        shape('el_ell', 'ellipse', { width: 100, height: 60 }),
        shape('el_line', 'line', { width: 200, height: 10 }),
        shape('el_star', 'star', { sides: 6, innerRadius: 0.4 }),
      ]),
    ]);
    const { scene } = await sceneFor(doc);
    const body = (id: string) => scene.getElementNode(id)!.getChildren()[1] as KonvaShape;
    expect(body('el_rect')).toBeInstanceOf(Konva.Rect);
    expect(body('el_rect').getAttr('cornerRadius')).toBe(9);
    expect(body('el_rect').dash()).toEqual([4, 2]);
    expect(body('el_rect').lineJoin()).toBe('miter');
    expect(body('el_rect').strokeScaleEnabled()).toBe(true);
    expect(body('el_ell')).toBeInstanceOf(Konva.Ellipse);
    expect([body('el_ell').x(), body('el_ell').y(), body('el_ell').getAttr('radiusX'), body('el_ell').getAttr('radiusY')]).toEqual([50, 30, 50, 30]);
    expect(body('el_line')).toBeInstanceOf(Konva.Line);
    expect(body('el_line').getAttr('points')).toEqual([0, 5, 200, 5]);
    expect(body('el_line').fill()).toBeUndefined();
    expect(body('el_line').lineCap()).toBe('butt');
    expect(body('el_line').getAttr('closed')).toBe(false);
    expect(body('el_star')).toBeInstanceOf(Konva.Line);
    expect(body('el_star').getAttr('closed')).toBe(true);
    expect(body('el_star').getAttr('points')).toHaveLength(24);
    scene.destroy();
  });
});

describe('images (§3.2, §3.5)', () => {
  it('scales an explicit crop to a half-resolution rendition', async () => {
    const assets = fixtureAssets();
    const doc = makeDoc(customPageSize(400, 400), [page('pg_1', [image('el_h', 'as_half', { crop: { x: 20, y: 10, width: 100, height: 80 } })])], {
      as_half: assets['as_half']!,
    });
    const { scene, resources } = await sceneFor(doc);
    expect(resources.images.get('as_half')!.width).toBe(100);
    const img = (scene.getElementNode('el_h')!.getChildren()[1] as KonvaGroup).getChildren()[0] as KonvaShape;
    expect(img.getAttr('cropX')).toBe(10);
    expect(img.getAttr('cropY')).toBe(5);
    expect(img.getAttr('cropWidth')).toBe(50);
    expect(img.getAttr('cropHeight')).toBe(40);
    scene.destroy();
  });

  it('flips with an inner group (the only non-unit scales)', async () => {
    const doc = makeDoc(customPageSize(400, 400), [page('pg_1', [image('el_f', 'as_photo', { flipX: true, flipY: true, width: 120, height: 90 })])], {
      as_photo: fixtureAssets()['as_photo']!,
    });
    const { scene } = await sceneFor(doc);
    const flip = scene.getElementNode('el_f')!.getChildren()[1] as KonvaGroup;
    expect([flip.x(), flip.y(), flip.scaleX(), flip.scaleY()]).toEqual([120, 90, -1, -1]);
    scene.destroy();
  });

  it('rasterizes SVGs at the declared size × svgRasterScale', async () => {
    const assets = fixtureAssets();
    const doc = makeDoc(customPageSize(400, 400), [page('pg_1', [image('el_s', 'as_svg')])], { as_svg: assets['as_svg']! });
    const { resources } = await sceneFor(doc);
    const svg = resources.images.get('as_svg')!;
    expect([svg.width, svg.height]).toEqual([480, 320]);
  });

  it('missing assets: export refuses (AssetLoadError); the editor gets a placeholder that is replaced once loaded', async () => {
    const broken = { ...fixtureAssets()['as_photo']!, src: 'data:image/png;base64,AAAA' };
    const doc = makeDoc(customPageSize(400, 400), [page('pg_1', [image('el_x', 'as_broken')])], { as_broken: broken });
    await expect(prepareResources(doc, undefined, env)).rejects.toBeInstanceOf(AssetLoadError);
    const resources = await prepareResources(doc, undefined, env, { allowMissingAssets: true });
    expect(resources.missingAssets).toEqual(['as_broken']);
    const scene = new PageScene({ doc, pageId: 'pg_1', resources, pixelRatio: 1 });
    const inner = () => (scene.getElementNode('el_x')!.getChildren()[1] as KonvaGroup).getChildren()[0]!;
    expect(inner().name()).toBe(ASSET_PLACEHOLDER_NAME);
    // the asset gets fixed (e.g. re-uploaded) and resources are refreshed
    const fixed = { ...doc, assets: { as_broken: fixtureAssets()['as_photo']! } };
    const next = await prepareResources(fixed, undefined, env, { into: createEmptyResources() });
    scene.update(fixed, { resources: next });
    expect(inner()).toBeInstanceOf(Konva.Image);
    scene.destroy();
  });

  it('remote srcs are refused by the Node env without a fetcher (SSRF guard)', async () => {
    const remote = { ...fixtureAssets()['as_photo']!, src: 'https://example.com/a.png' };
    const doc = makeDoc(customPageSize(400, 400), [page('pg_1', [image('el_x', 'as_r')])], { as_r: remote });
    await expect(prepareResources(doc, undefined, env)).rejects.toBeInstanceOf(AssetLoadError);
  });
});

describe('fonts barrier (§3.1)', () => {
  it('rejects with FontLoadError listing the missing variants unless fallback fonts are allowed', async () => {
    const doc = makeDoc(customPageSize(400, 400), [page('pg_1', [text('el_t', { content: 'x', fontFamily: 'Not Registered', fontWeight: 700 })])]);
    const bare = createNodeEnv();
    const err = await prepareResources(doc, undefined, bare).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FontLoadError);
    expect((err as FontLoadError).missing).toEqual(['"Not Registered" normal 700']);
    const r = await prepareResources(doc, undefined, bare, { allowFallbackFonts: true });
    expect(r.missingFonts).toEqual(['"Not Registered" normal 700']);
  });
});

describe('reconciliation (§2.2)', () => {
  const base = () =>
    makeDoc(customPageSize(600, 600), [
      page('pg_1', [shape('el_1', 'rect'), shape('el_2', 'ellipse', { x: 200 }), text('el_3', { content: 'Three', y: 300 })]),
      page('pg_2', [shape('el_9', 'rect')]),
    ]);

  it('reuses unchanged nodes, re-applies changed ones, reorders, deletes and inserts', async () => {
    let doc = base();
    const { scene } = await sceneFor(doc);
    const n1 = scene.getElementNode('el_1')!;
    const n2 = scene.getElementNode('el_2')!;
    const t3 = textNode(scene, 'el_3');
    doc = editElement(doc, 'pg_1', 'el_2', (e) => ({ ...e, x: 250 }));
    scene.update(doc);
    expect(scene.getElementNode('el_1')).toBe(n1);
    expect(scene.getElementNode('el_2')).toBe(n2);
    expect(n2.x()).toBe(250);
    expect(textNode(scene, 'el_3')).toBe(t3);
    // reorder + delete + insert
    doc = editPage(doc, 'pg_1', (p) => ({ ...p, elements: [p.elements[2]!, shape('el_4', 'star'), p.elements[0]!] }));
    scene.update(doc);
    expect(scene.getElementNode('el_2')).toBeUndefined();
    expect(n2.getParent()).toBeFalsy();
    const content = scene.root.getChildren()[0] as KonvaGroup;
    expect(content.getChildren().slice(2).map((c) => c.id())).toEqual(['el_3', 'el_4', 'el_1']);
    scene.destroy();
  });

  it('dirty re-applies a reference-equal element whose node moved live (no-op drag)', async () => {
    const doc = base();
    const { scene } = await sceneFor(doc);
    const n = scene.getElementNode('el_1')!;
    n.position({ x: 999, y: 999 });
    n.scale({ x: 2, y: 2 });
    scene.update(doc);
    expect(n.x()).toBe(999); // reference-equal and not dirty: untouched
    scene.update(doc, { dirty: ['el_1'] });
    expect([n.x(), n.y(), n.scaleX(), n.scaleY()]).toEqual([40, 40, 1, 1]);
    scene.destroy();
  });

  it('rebuildText destroys and recreates text nodes', async () => {
    const doc = base();
    const { scene } = await sceneFor(doc);
    const before = scene.getElementNode('el_3')!;
    scene.update(doc, { rebuildText: true });
    expect(scene.getElementNode('el_3')).not.toBe(before);
    expect(before.getParent()).toBeFalsy();
    scene.destroy();
  });

  it('page size changes re-apply content scale, clip and background', async () => {
    const doc = base();
    const { scene } = await sceneFor(doc, 1);
    const resized = { ...doc, size: presetToPageSize('a4-poster') };
    scene.update(resized);
    const content = scene.root.getChildren()[0] as KonvaGroup;
    expect(content.clip()).toEqual({ x: 0, y: 0, width: resized.size.width, height: resized.size.height });
    expect(content.scaleX()).toBe(exportPixelSize(resized.size, 1).contentScaleX);
    expect(rasterizePage(scene, 1).width).toBe(794);
    scene.destroy();
  });

  it('throws for a page that is no longer in the document', async () => {
    const doc = base();
    const { scene } = await sceneFor(doc);
    expect(() => scene.update({ ...doc, pages: [doc.pages[1]!] })).toThrow(/not in the document/);
    scene.destroy();
  });
});

describe('editor helpers', () => {
  it('maps hit nodes to element and page ids; frames hold exactly one root', async () => {
    const doc = makeDoc(customPageSize(600, 600), [page('pg_1', [text('el_t', { content: 'Hit me' }), image('el_i', 'as_photo')])], {
      as_photo: fixtureAssets()['as_photo']!,
    });
    const { scene } = await sceneFor(doc);
    const frame = createPageFrame({ x: 100, y: 50 });
    mountPageScene(frame, scene);
    expect(scene.root.getParent()).toBe(frame);
    expect(getElementIdFromNode(textNode(scene, 'el_t'))).toBe('el_t');
    const img = (scene.getElementNode('el_i')!.getChildren()[1] as KonvaGroup).getChildren()[0]!;
    expect(getElementIdFromNode(img)).toBe('el_i');
    expect(getElementIdFromNode(scene.getElementNode('el_i')!.getChildren()[0]!)).toBe('el_i'); // hitbox
    const bg = (scene.root.getChildren()[0] as KonvaGroup).getChildren()[0]!;
    expect(getElementIdFromNode(bg)).toBeNull();
    expect(getPageIdFromNode(img)).toBe('pg_1');
    expect(getElementIdFromNode(frame)).toBeNull();
    frame.add(new Konva.Rect());
    const other = new PageScene({ doc, pageId: 'pg_1', resources: createEmptyResources(), pixelRatio: 1 });
    expect(() => mountPageScene(createPageFrame({ x: 0, y: 0 }).add(new Konva.Rect()) as KonvaGroup, other)).toThrow();
    other.destroy();
    scene.destroy();
  });

  it('the hitbox never paints', async () => {
    const doc = makeDoc(customPageSize(200, 200), [page('pg_1', [text('el_t', { content: '', x: 0, y: 0, width: 200, height: 200 })], { color: null, image: null })]);
    const { scene } = await sceneFor(doc);
    const px = rgba(rasterizePage(scene, 1));
    expect(px.every((b) => b === 0)).toBe(true);
    scene.destroy();
  });
});
