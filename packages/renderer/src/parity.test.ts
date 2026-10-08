/**
 * render-export-pipeline.md §6.1 tests 2 (editor path vs export path, byte-exact) and
 * 3 (chrome isolation).
 */
import { createTestEnv, LATE_FONT, countDiffBytes, editElement, editPage, rgba, shape, image, text, FIXTURE_FAMILY } from './test-support.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pixelmatch from 'pixelmatch';
import {
  bakeTransform,
  exportPixelSize,
  removeElements,
  transformerConstraints,
  type PlakatDocument,
  type PlakatElement,
} from '@plakat/schema';
import { kitchenSinkDoc } from './fixture-docs.ts';
import { Konva, type KonvaGroup, type KonvaLayer, type KonvaNode, type KonvaStage, type KonvaText } from './konva.ts';
import type { Transformer } from 'konva/lib/shapes/Transformer';
import { PageScene } from './scene.ts';
import { rasterizePage } from './rasterize.ts';
import { prepareResources } from './resources.ts';
import { renderPageCanvas } from './export.ts';
import { createPageFrame, mountPageScene } from './editor.ts';
import { RasterError } from './errors.ts';
import type { Resources } from './types.ts';

const T = 180_000;
const S_VALUES = [1, 2, 3.125] as const;

function el(doc: PlakatDocument, pageId: string, id: string): PlakatElement {
  const found = doc.pages.find((p) => p.id === pageId)!.elements.find((e) => e.id === id);
  if (!found) throw new Error(`no element ${id}`);
  return found;
}

/** Konva attribute dump of a scene (for diagnosing attribute drift between update and fresh build). */
function dumpScene(scene: PageScene): unknown {
  const walk = (n: KonvaNode): unknown => {
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.attrs as Record<string, unknown>)) {
      if (k === 'image' || k === 'plakatImage' || k === 'plakatAsset') attrs[k] = v ? `${(v as { width: number }).width}x${(v as { height: number }).height}` : v;
      else if (typeof v === 'function') attrs[k] = v === (n as unknown as Record<string, unknown>)[k] ? 'fn' : 'fn';
      else if (k === 'filters') attrs[k] = (v as { name: string }[]).map((f) => f.name);
      else attrs[k] = v;
    }
    const children = (n as KonvaGroup).getChildren?.() ?? [];
    return { cls: n.getClassName(), cached: n.isCached(), attrs, children: children.map(walk) };
  };
  return walk(scene.root);
}

describe('editor path vs export path (§6.1.2) and chrome isolation (§6.1.3)', () => {
  let doc: PlakatDocument;
  let stage: KonvaStage;
  let chrome: KonvaLayer;
  let frameA: KonvaGroup;
  let frameB: KonvaGroup;
  let sceneA: PageScene;
  let sceneB: PageScene;
  /** Same edits as sceneB, but WITHOUT rebuildText after the late font: must differ (test has teeth). */
  let sceneStale: PageScene;
  let resources: Resources;
  const envFull = createTestEnv([LATE_FONT]);
  let lateNodeWidthsBefore: number[] = [];

  beforeAll(async () => {
    const envEditor = createTestEnv(); // the late family is not available yet
    doc = kitchenSinkDoc();
    resources = await prepareResources(doc, ['pg_a', 'pg_b'], envEditor, { allowFallbackFonts: true });
    expect(resources.missingFonts.some((m) => m.includes('Plakat Late Sans'))).toBe(true);

    // --- editor-shaped stage: zoom ≠ 1, pan, two frames, chrome layer -----------------
    const zoom = 0.37;
    stage = new Konva.Stage({ width: 900, height: 700 } as ConstructorParameters<typeof Konva.Stage>[0]);
    stage.scale({ x: zoom, y: zoom });
    stage.position({ x: -37.5, y: 12.25 });
    const content = new Konva.Layer();
    chrome = new Konva.Layer();
    stage.add(content, chrome);
    sceneA = new PageScene({ doc, pageId: 'pg_a', resources, pixelRatio: zoom });
    sceneB = new PageScene({ doc, pageId: 'pg_b', resources, pixelRatio: zoom });
    sceneStale = new PageScene({ doc, pageId: 'pg_b', resources, pixelRatio: zoom });
    frameA = createPageFrame({ x: 40, y: 40 });
    frameB = createPageFrame({ x: 40 + doc.size.width + 60.5, y: 40 });
    content.add(frameA, frameB);
    mountPageScene(frameA, sceneA);
    mountPageScene(frameB, sceneB);
    const selected = [el(doc, 'pg_b', 'el_rect'), el(doc, 'pg_b', 'el_cover')];
    const tr = new Konva.Transformer({
      nodes: [sceneB.getElementNode('el_rect')!, sceneB.getElementNode('el_cover')!],
      ...transformerConstraints(selected),
    });
    chrome.add(tr);
    chrome.add(new Konva.Line({ points: [0, 300, 4000, 300], stroke: '#ff00ff', strokeWidth: 1, strokeScaleEnabled: false }));
    chrome.add(new Konva.Line({ points: [900, 0, 900, 4000], stroke: '#ff00ff', strokeWidth: 1, strokeScaleEnabled: false }));
    chrome.add(new Konva.Rect({ x: 900, y: 80, width: 200, height: 100, stroke: '#0a84ff', strokeWidth: 2, strokeScaleEnabled: false }));
    stage.draw();

    const step = (next: PlakatDocument, opts: Parameters<PageScene['update']>[1] = {}) => {
      doc = next;
      sceneA.update(doc, opts);
      sceneB.update(doc, opts);
      const { rebuildText: _ignored, ...staleOpts } = opts;
      sceneStale.update(doc, staleOpts);
      stage.draw();
    };

    // 1. move
    step(editElement(doc, 'pg_b', 'el_ellipse', (e) => ({ ...e, x: e.x + 33.3, y: e.y + 12 })));
    // 2. resize through bakeTransform (live node scale, then commit + dirty)
    for (const sc of [sceneB, sceneStale]) {
      const n = sc.getElementNode('el_rect')!;
      n.setAttrs({ scaleX: 1.25, scaleY: 0.8, x: n.x() + 5 });
    }
    {
      const n = sceneB.getElementNode('el_rect')!;
      const baked = bakeTransform(el(doc, 'pg_b', 'el_rect'), { x: n.x(), y: n.y(), rotation: n.rotation(), scaleX: n.scaleX(), scaleY: n.scaleY() });
      step(editElement(doc, 'pg_b', 'el_rect', () => baked), { dirty: ['el_rect'] });
    }
    // uniform text resize (scales fontSize)
    for (const sc of [sceneB, sceneStale]) sc.getElementNode('el_middle')!.scale({ x: 1.1, y: 1.1 });
    {
      const n = sceneB.getElementNode('el_middle')!;
      const baked = bakeTransform(el(doc, 'pg_b', 'el_middle'), { x: n.x(), y: n.y(), rotation: n.rotation(), scaleX: n.scaleX(), scaleY: n.scaleY() });
      step(editElement(doc, 'pg_b', 'el_middle', () => baked), { dirty: ['el_middle'] });
    }
    // 3. restyle
    step(editElement(doc, 'pg_b', 'el_middle', (e) => ({ ...e, fill: '#af52de', fontWeight: 400, content: 'Restyled middle text, now longer so it wraps' }) as PlakatElement));
    step(editElement(doc, 'pg_b', 'el_star', (e) => ({ ...e, fill: '#ff2d55', sides: 5, innerRadius: 0.6 }) as PlakatElement));
    step(editElement(doc, 'pg_b', 'el_upper', (e) => ({ ...e, letterSpacing: 0.2, textTransform: 'capitalize' }) as PlakatElement));
    // shape kind change (same id, different Konva class)
    step(editElement(doc, 'pg_b', 'el_triangle', (e) => ({ ...e, shape: 'ellipse' }) as PlakatElement));
    // 4. reorder: triangle to the top
    step(
      editPage(doc, 'pg_b', (p) => {
        const els = p.elements.filter((e) => e.id !== 'el_triangle');
        return { ...p, elements: [...els, p.elements.find((e) => e.id === 'el_triangle')!] };
      }),
    );
    // 5. delete
    step(removeElements(doc, ['el_polygon']));
    // 6. insert
    step(
      editPage(doc, 'pg_b', (p) => ({
        ...p,
        elements: [
          shape('el_new_star', 'star', { x: 600, y: 200, width: 140, height: 120, sides: 8, fill: '#5ac8fa', stroke: '#1d1d1f', strokeWidth: 3, rotation: 12 }),
          ...p.elements,
          image('el_new_img', 'as_jpeg', { x: 560, y: 760, width: 140.5, height: 90.25, filters: { blur: 3, brightness: -20 }, cornerRadius: 10 }),
          text('el_new_text', { x: 560, y: 870, width: 200, height: 40, content: 'Inserted', fontFamily: FIXTURE_FAMILY, fontWeight: 700 }),
        ],
      })),
    );
    // 7. hide / unhide
    step(editElement(doc, 'pg_b', 'el_ellipse', (e) => ({ ...e, hidden: true })));
    step(editElement(doc, 'pg_b', 'el_ellipse', (e) => ({ ...e, hidden: false })));
    step(editElement(doc, 'pg_b', 'el_svg', (e) => ({ ...e, hidden: true })));
    // 8. filters: change, neutralize (drops the cache), activate (adds a cache)
    step(editElement(doc, 'pg_b', 'el_blur', (e) => (e.type === 'image' ? { ...e, filters: { ...e.filters, blur: 10 } } : e)));
    step(editElement(doc, 'pg_b', 'el_contrast', (e) => (e.type === 'image' ? { ...e, filters: { ...e.filters, contrast: 0, saturation: 0 } } : e)));
    step(editElement(doc, 'pg_b', 'el_cover', (e) => (e.type === 'image' ? { ...e, filters: { ...e.filters, brightness: -30 } } : e)));
    // 9. no-op drag: node moved live, store commits the SAME values (same reference)
    for (const sc of [sceneB, sceneStale]) {
      const n = sc.getElementNode('el_star')!;
      n.position({ x: n.x() + 120, y: n.y() - 40 });
    }
    step(doc, { dirty: ['el_star'] });
    expect(sceneB.getElementNode('el_star')!.x()).toBe(el(doc, 'pg_b', 'el_star').x);
    // page A edits (background changes)
    step(editPage(doc, 'pg_a', (p) => ({ ...p, background: { color: '#ffeedd', image: { assetId: 'as_photo' } } })));
    step(editPage(doc, 'pg_a', (p) => ({ ...p, background: { color: null, image: null } })));
    step(editElement(doc, 'pg_a', 'el_a_title', (e) => ({ ...e, content: 'Page one, edited' }) as PlakatElement));
    // 10. a font that loads after the scene was built
    lateNodeWidthsBefore = (sceneB.getElementNode('el_late')!.getChildren()[1] as KonvaText).textArr.map((l) => l.width);
    await prepareResources(doc, ['pg_a', 'pg_b'], envFull, { into: resources });
    step(doc, { rebuildText: ['el_late'] });
    // 11. change pixel ratio (zoom change in the editor), then back
    stage.scale({ x: 0.74, y: 0.74 });
    for (const sc of [sceneA, sceneB, sceneStale]) sc.setPixelRatio(0.74);
    stage.draw();
    stage.scale({ x: 0.37, y: 0.37 });
    for (const sc of [sceneA, sceneB, sceneStale]) sc.setPixelRatio(0.37);
    // a last edit after everything
    step(editElement(doc, 'pg_b', 'el_cap', (e) => ({ ...e, y: e.y + 7.75, rotation: 4 })));
    stage.draw();
  }, 180_000);

  afterAll(() => {
    sceneStale?.destroy();
    stage?.destroy();
  });

  it('the late font really changed the text metrics (rebuildText is exercised)', () => {
    const after = (sceneB.getElementNode('el_late')!.getChildren()[1] as KonvaText).textArr.map((l) => l.width);
    expect(after).not.toEqual(lateNodeWidthsBefore);
  });

  it('incremental updates leave exactly the attributes of a fresh build', () => {
    const fresh = new PageScene({ doc, pageId: 'pg_b', resources, pixelRatio: sceneB.pixelRatio });
    try {
      expect(dumpScene(sceneB)).toEqual(dumpScene(fresh));
    } finally {
      fresh.destroy();
    }
  });

  for (const s of S_VALUES) {
    it(
      `rasterizePage(editor scene) is byte-identical to the export at s=${s}`,
      async () => {
        const { width: W, height: H } = exportPixelSize(doc.size, s);
        const editorCanvas = rasterizePage(sceneB, s);
        expect([editorCanvas.width, editorCanvas.height]).toEqual([W, H]);
        const exported = await renderPageCanvas(doc, 'pg_b', { scale: s, env: envFull });
        expect([exported.width, exported.height]).toEqual([W, H]);
        const a = rgba(editorCanvas);
        if (process.env['PLAKAT_DEBUG_DIR']) (await import('node:fs')).writeFileSync(`${process.env['PLAKAT_DEBUG_DIR']}/parity-${s}.png`, (editorCanvas as unknown as { toBuffer(m: string): Buffer }).toBuffer('image/png'));
        const b = rgba(exported.canvas);
        exported.release();
        Konva.Util.releaseCanvas(editorCanvas);
        expect(a.length).toBe(W * H * 4);
        expect(countDiffBytes(a, b)).toBe(0);
        expect(pixelmatch(a, b, null, W, H, { threshold: 0 })).toBe(0);
        expect(a.equals(b)).toBe(true);
        // the editor scene is restored to its on-screen ratio afterwards
        expect(sceneB.pixelRatio).toBe(0.37);
      },
      T,
    );
  }

  it(
    'page A (transparent background) matches too, at 1x and 2x',
    async () => {
      for (const s of [1, 2]) {
        const a = rgba(rasterizePage(sceneA, s));
        const exported = await renderPageCanvas(doc, 'pg_a', { scale: s, env: envFull });
        expect(a.equals(rgba(exported.canvas))).toBe(true);
        exported.release();
      }
    },
    T,
  );

  it(
    'without rebuildText after a late font the result differs (the parity test has teeth)',
    async () => {
      const a = rgba(rasterizePage(sceneStale, 1));
      const exported = await renderPageCanvas(doc, 'pg_b', { scale: 1, env: envFull });
      expect(a.equals(rgba(exported.canvas))).toBe(false);
      exported.release();
    },
    T,
  );

  it(
    'chrome isolation: zoom, pan, frame offsets, hidden frames and chrome content never reach the raster',
    async () => {
      const exported = await renderPageCanvas(doc, 'pg_b', { scale: 1, env: envFull });
      const ref = rgba(exported.canvas);
      exported.release();
      const before = rgba(rasterizePage(sceneB, 1));
      expect(before.equals(ref)).toBe(true);

      stage.scale({ x: 1.9, y: 1.9 });
      stage.position({ x: 311.3, y: -97.6 });
      frameB.position({ x: -500.25, y: 1234.5 });
      chrome.add(new Konva.Rect({ x: -10000, y: -10000, width: 20000, height: 20000, fill: '#00ff00' }));
      (chrome.findOne('Transformer') as Transformer).nodes([sceneB.getElementNode('el_star')!]);
      stage.draw();
      expect(rgba(rasterizePage(sceneB, 1)).equals(ref)).toBe(true);

      frameB.visible(false);
      expect(rgba(rasterizePage(sceneB, 1)).equals(ref)).toBe(true);
      frameB.visible(true);

      // detached root (e.g. an off-screen page) rasterizes identically as well
      const detach = mountPageScene(frameB, sceneB);
      detach();
      expect(rgba(rasterizePage(sceneB, 1)).equals(ref)).toBe(true);
      mountPageScene(frameB, sceneB);

      frameB.opacity(0.5);
      expect(() => rasterizePage(sceneB, 1)).toThrow(RasterError);
      frameB.opacity(1);
    },
    T,
  );
});
