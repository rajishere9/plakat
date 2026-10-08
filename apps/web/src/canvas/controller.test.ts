// @vitest-environment jsdom
import { FontLoadError, Konva, rasterizePage, renderPageWithResources, type RenderEnv } from '@plakat/renderer';
import { createDocument, createImageElement, createShapeElement, createTextElement, type Asset, type ImageElement, type PlakatDocument, type TextElement } from '@plakat/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorStore, type EditorStore } from '../store/editor-store.ts';
import { WorkspaceController } from './controller.ts';

const VIEW_W = 800;
const VIEW_H = 600;

function makeHost(): HTMLDivElement {
  const div = document.createElement('div');
  Object.defineProperty(div, 'clientWidth', { value: VIEW_W, configurable: true });
  Object.defineProperty(div, 'clientHeight', { value: VIEW_H, configurable: true });
  document.body.appendChild(div);
  return div;
}

/** Test env: images are generated gradients (no network), fonts resolve immediately. */
function testEnv(): RenderEnv & { imageLoads: number } {
  const env = {
    kind: 'test',
    imageLoads: 0,
    async loadImage(_src: string, asset: Asset) {
      env.imageLoads++;
      const c = document.createElement('canvas');
      c.width = asset.width;
      c.height = asset.height;
      const ctx = c.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, asset.width, asset.height);
      g.addColorStop(0, '#ff0000');
      g.addColorStop(1, '#0000ff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, asset.width, asset.height);
      return c;
    },
    async loadFonts() {},
  };
  return env;
}

const ASSET: Asset = { type: 'image', mimeType: 'image/png', width: 400, height: 200, src: '/uploads/test.png', name: 'test', source: null };

function fixtureDoc(): PlakatDocument {
  const doc = createDocument({ width: 1000, height: 1000, presetId: null, physical: null }, { pageCount: 2 });
  doc.pages[0]!.background.color = '#ffffff';
  doc.pages[0]!.elements = [
    createShapeElement('rect', { id: 'r1', x: 100, y: 100, width: 200, height: 200, fill: '#ff8800', stroke: '#000000', strokeWidth: 4 }),
    createShapeElement('ellipse', { id: 'e1', x: 600, y: 100, width: 200, height: 100, fill: '#00aa88' }),
    createShapeElement('rect', { id: 'locked', x: 100, y: 700, width: 100, height: 100, fill: '#333333', locked: true }),
    createTextElement({ id: 't1', x: 400, y: 450, width: 300, height: 60, content: 'Hello Plakat', fontSize: 40, fill: '#111111' }),
    createImageElement('img', ASSET, { id: 'i1', x: 600, y: 650, width: 200, height: 200 }),
  ];
  doc.pages[1]!.elements = [createShapeElement('star', { id: 's2', x: 300, y: 300, width: 300, height: 300, fill: '#8844ff' })];
  doc.assets['img'] = ASSET;
  return doc;
}

interface Ctx {
  store: EditorStore;
  controller: WorkspaceController;
  env: ReturnType<typeof testEnv>;
  host: HTMLDivElement;
}

const live: WorkspaceController[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.destroy();
  document.body.innerHTML = '';
});

async function setup(doc = fixtureDoc()): Promise<Ctx> {
  const store = createEditorStore({ document: doc });
  const env = testEnv();
  const host = makeHost();
  const controller = new WorkspaceController({ host, store, env, devicePixelRatio: () => 1 });
  live.push(controller);
  await controller.ready();
  return { store, controller, env, host };
}

function el(store: EditorStore, id: string) {
  for (const p of store.getState().document.pages) {
    const e = p.elements.find((x) => x.id === id);
    if (e) return e;
  }
  throw new Error(`no element ${id}`);
}

/** Screen point of a page point on page 1 (or `pageIndex`). */
function at(c: Ctx, x: number, y: number, pageIndex = 0) {
  const pageId = c.store.getState().document.pages[pageIndex]!.id;
  return c.controller.pageToScreenPoint(pageId, { x, y })!;
}

function click(c: Ctx, p: { x: number; y: number }, mods: { shiftKey?: boolean } = {}) {
  c.controller.pointerDown({ ...p, button: 0, pointerId: 1, ...mods });
  c.controller.pointerUp({ ...p, button: 0, pointerId: 1, ...mods });
}

function drag(c: Ctx, from: { x: number; y: number }, to: { x: number; y: number }, mods: { altKey?: boolean; shiftKey?: boolean } = {}) {
  c.controller.pointerDown({ ...from, button: 0, pointerId: 1, ...mods });
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    c.controller.pointerMove({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, pointerId: 1, ...mods });
  }
  c.controller.pointerUp({ ...to, button: 0, pointerId: 1, ...mods });
}

function pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Editor scene (rasterizePage) vs export path (fresh scene), byte-exact. */
function expectParity(c: Ctx, pageIndex: number, scale: number) {
  const doc = c.store.getState().document;
  const pageId = doc.pages[pageIndex]!.id;
  const editor = rasterizePage(c.controller.getScene(pageId)!, scale);
  const exported = renderPageWithResources(doc, pageId, c.controller.getResources(), scale, { env: c.env });
  try {
    expect(editor.width).toBe(exported.width);
    expect(editor.height).toBe(exported.height);
    const a = pixels(editor);
    const b = pixels(exported.canvas);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBe(0);
  } finally {
    Konva.Util.releaseCanvas(editor);
    exported.release();
  }
}

describe('WorkspaceController: build & view', () => {
  it('builds one page frame + PageScene per page behind the readiness barrier', async () => {
    const c = await setup();
    const doc = c.store.getState().document;
    expect(c.controller.getScene(doc.pages[0]!.id)).toBeDefined();
    expect(c.controller.getScene(doc.pages[1]!.id)).toBeDefined();
    expect(c.env.imageLoads).toBe(1);
    // every frame holds exactly one root (P-12)
    const frames = c.controller.contentLayer.getChildren();
    expect(frames).toHaveLength(2);
    for (const f of frames) expect((f as unknown as { getChildren(): unknown[] }).getChildren()).toHaveLength(1);
    // the root never carries zoom/pan
    const root = c.controller.getScene(doc.pages[0]!.id)!.root;
    expect(root.x()).toBe(0);
    expect(root.scaleX()).toBe(1);
    expect(c.controller.getStatus()).toEqual({ loading: false, missingFonts: [], missingAssets: [] });
  });

  it('zooms to fit on load and puts zoom/pan on the stage', async () => {
    const c = await setup();
    const { zoom, zoomMode } = c.store.getState();
    expect(zoomMode).toBe('fit');
    expect(zoom).toBeCloseTo((VIEW_H - 96) / 1000, 9);
    const v = c.controller.getView();
    expect(v.zoom).toBe(zoom);
    expect(c.controller.stage.scaleX()).toBe(zoom);
    expect(c.controller.stage.x()).toBe(v.panX);
    // page 1 horizontally centered
    const origin = at(c, 0, 0);
    expect(origin.x + (1000 * zoom) / 2).toBeCloseTo(VIEW_W / 2, 0);
  });

  it('wheel+Mod zooms around the cursor; plain wheel pans', async () => {
    const c = await setup();
    const anchor = at(c, 250, 250);
    c.controller.wheel({ ...anchor, deltaX: 0, deltaY: -100, ctrlKey: true });
    const s = c.store.getState();
    expect(s.zoomMode).toBe('manual');
    expect(s.zoom).toBeGreaterThan(0.504);
    const after = at(c, 250, 250);
    expect(after.x).toBeCloseTo(anchor.x, 0);
    expect(after.y).toBeCloseTo(anchor.y, 0);
    const before = c.controller.getView();
    c.controller.wheel({ x: 10, y: 10, deltaX: 0, deltaY: 40 });
    expect(c.controller.getView().panY).toBe(before.panY - 40);
  });

  it('store zoom presets zoom around the viewport center', async () => {
    const c = await setup();
    const center = { x: VIEW_W / 2, y: VIEW_H / 2 };
    const p = c.controller.screenToPagePoint(center)!;
    c.store.getState().actions.zoomTo100();
    expect(c.controller.getView().zoom).toBe(1);
    const back = c.controller.pageToScreenPoint(p.pageId, p)!;
    expect(back.x).toBeCloseTo(center.x, 0);
    expect(back.y).toBeCloseTo(center.y, 0);
  });

  it('activating a page scrolls it into view', async () => {
    const c = await setup();
    c.store.getState().actions.zoomTo100();
    const page2 = c.store.getState().document.pages[1]!.id;
    c.store.getState().actions.setActivePage(page2);
    const o = c.controller.pageToScreenPoint(page2, { x: 0, y: 0 })!;
    expect(o.y).toBeLessThanOrEqual(48 + 1e-9);
    expect(o.y + 1000).toBeGreaterThan(0);
  });
});

describe('WorkspaceController: selection', () => {
  it('click selects, Shift-click toggles, click on the page background deselects', async () => {
    const c = await setup();
    click(c, at(c, 150, 150));
    expect(c.store.getState().selectedIds).toEqual(['r1']);
    expect(c.controller.transformer.nodes().map((n) => n.id())).toEqual(['r1']);
    click(c, at(c, 700, 150), { shiftKey: true });
    expect(c.store.getState().selectedIds).toEqual(['r1', 'e1']);
    click(c, at(c, 700, 150), { shiftKey: true });
    expect(c.store.getState().selectedIds).toEqual(['r1']);
    click(c, at(c, 500, 300));
    expect(c.store.getState().selectedIds).toEqual([]);
  });

  it('hidden elements are not hit-testable; locked ones are selectable but get no transformer', async () => {
    const c = await setup();
    c.store.getState().actions.setHidden(['e1'], true);
    expect(c.controller.elementAt(at(c, 700, 150))).toBeNull();
    click(c, at(c, 150, 750));
    expect(c.store.getState().selectedIds).toEqual(['locked']);
    expect(c.controller.transformer.nodes()).toHaveLength(0);
  });

  it('marquee selects intersecting, unlocked, visible elements', async () => {
    const c = await setup();
    drag(c, at(c, 50, 50), at(c, 650, 160));
    expect(c.store.getState().selectedIds).toEqual(['r1', 'e1']);
    // Shift-marquee adds
    drag(c, at(c, 380, 430), at(c, 450, 480), { shiftKey: true });
    expect(c.store.getState().selectedIds).toEqual(['r1', 'e1', 't1']);
  });

  it('clicking an element on another page selects it and activates that page', async () => {
    const c = await setup();
    c.store.getState().actions.zoomTo100();
    const page2 = c.store.getState().document.pages[1]!.id;
    c.controller.scrollToPage(page2);
    click(c, at(c, 450, 450, 1));
    expect(c.store.getState().selectedIds).toEqual(['s2']);
    expect(c.store.getState().activePageId).toBe(page2);
  });
});

describe('WorkspaceController: drag & transform', () => {
  it('drag moves the selection with live snapping and commits one undo step', async () => {
    const c = await setup();
    const zoom = c.controller.getView().zoom;
    // r1 center x = 200; move by 297 px → center 497, snaps to the page center 500
    const from = at(c, 150, 150);
    drag(c, from, { x: from.x + 297 * zoom, y: from.y });
    const r1 = el(c.store, 'r1');
    expect(r1.x).toBeCloseTo(400, 6);
    expect(r1.y).toBeCloseTo(100, 6);
    expect(c.store.getState().undoLabel).toBe('Move');
    // node at rest equals the document (P-3 / §2.2)
    const node = c.controller.getElementNode('r1')!;
    expect(node.x()).toBeCloseTo(400, 6);
    expectParity(c, 0, 1);
    c.store.getState().actions.undo();
    expect(el(c.store, 'r1').x).toBe(100);
    expect(c.controller.getElementNode('r1')!.x()).toBe(100);
  });

  it('Alt disables snapping', async () => {
    const c = await setup();
    const zoom = c.controller.getView().zoom;
    const from = at(c, 150, 150);
    drag(c, from, { x: from.x + 297 * zoom, y: from.y }, { altKey: true });
    expect(el(c.store, 'r1').x).toBeCloseTo(397, 3);
  });

  it('locked elements are not draggable; a press on one starts a marquee, a click selects it', async () => {
    const c = await setup();
    const from = at(c, 150, 750);
    drag(c, from, { x: from.x + 100, y: from.y + 100 });
    expect(el(c.store, 'locked').x).toBe(100);
    expect(c.store.getState().selectedIds).toEqual([]);
    click(c, at(c, 150, 750));
    expect(c.store.getState().selectedIds).toEqual(['locked']);
  });

  it('a full-page locked background does not block rubber-band selection', async () => {
    const doc = fixtureDoc();
    doc.pages[0]!.elements.unshift(createShapeElement('rect', { id: 'bg', x: 0, y: 0, width: 1000, height: 1000, fill: '#eeeeee', locked: true }));
    const c = await setup(doc);
    drag(c, at(c, 50, 50), at(c, 650, 160));
    expect(c.store.getState().selectedIds).toEqual(['r1', 'e1']);
    // Already-selected locked background: still a marquee.
    click(c, at(c, 500, 600));
    expect(c.store.getState().selectedIds).toEqual(['bg']);
    drag(c, at(c, 380, 430), at(c, 450, 480));
    expect(c.store.getState().selectedIds).toEqual(['t1']);
  });

  it('dropping a dragged element over another page moves it to that page (one undo step)', async () => {
    const c = await setup();
    const page2 = c.store.getState().document.pages[1]!.id;
    click(c, at(c, 150, 150));
    drag(c, at(c, 150, 150), at(c, 160, 170, 1), { altKey: true });
    const doc = c.store.getState().document;
    expect(doc.pages[0]!.elements.some((e) => e.id === 'r1')).toBe(false);
    const moved = doc.pages[1]!.elements.find((e) => e.id === 'r1')!;
    expect(moved.x).toBeCloseTo(110, 4);
    expect(moved.y).toBeCloseTo(120, 4);
    expect(doc.pages[1]!.elements.at(-1)!.id).toBe('r1');
    expect(c.store.getState().activePageId).toBe(page2);
    expect(c.store.getState().selectedIds).toEqual(['r1']);
    expect(c.store.getState().undoLabel).toBe('Move to page');
    expect(c.controller.getScene(page2)!.getElementNode('r1')).toBeTruthy();
    expectParity(c, 0, 1);
    expectParity(c, 1, 1);
    c.store.getState().actions.undo();
    expect(c.store.getState().document.pages[0]!.elements.find((e) => e.id === 'r1')).toMatchObject({ x: 100, y: 100 });
    expect(c.store.getState().document.pages[1]!.elements.some((e) => e.id === 'r1')).toBe(false);
  });

  it('commits Transformer results through bakeTransform and resets the node', async () => {
    const c = await setup();
    click(c, at(c, 700, 150));
    const node = c.controller.getElementNode('e1')!;
    const tr = c.controller.transformer;
    tr.fire('transformstart');
    node.setAttrs({ scaleX: 1.5, scaleY: 2, x: 550 });
    tr.fire('transform');
    tr.fire('transformend');
    const e1 = el(c.store, 'e1');
    expect(e1.x).toBeCloseTo(550, 6);
    expect(e1.width).toBeCloseTo(300, 4);
    expect(e1.height).toBeCloseTo(200, 4);
    expect(c.store.getState().undoLabel).toBe('Resize');
    expect(node.scaleX()).toBe(1);
    expectParity(c, 0, 1);
    expectParity(c, 0, 2);
  });

  it('side-resizing a text re-wraps live and commits the width only', async () => {
    const c = await setup();
    click(c, at(c, 450, 470));
    const tr = c.controller.transformer;
    expect(tr.enabledAnchors()).toContain('middle-right');
    (tr as unknown as { _movingAnchorName: string })._movingAnchorName = 'middle-right';
    tr.fire('transformstart');
    const node = c.controller.getElementNode('t1')!;
    node.scaleX(0.5);
    tr.fire('transform');
    expect(node.scaleX()).toBe(1); // re-wrapped through applyElement, never stretched
    (tr as unknown as { _movingAnchorName: string | null })._movingAnchorName = null;
    tr.fire('transformend');
    const t1 = el(c.store, 't1') as TextElement;
    expect(t1.width).toBeCloseTo(150, 6);
    expect(t1.fontSize).toBe(40);
    expect(t1.height).toBeGreaterThan(60); // 'Hello Plakat' wraps → auto-grown
    expectParity(c, 0, 1);
  });

  it('a rotated multi-selection transform stays representable (no skew from the content scale)', async () => {
    const c = await setup();
    // A4-like fractional page: contentScaleX ≠ contentScaleY at most ratios
    const doc = createDocument('a4-poster');
    doc.pages[0]!.elements = [
      createShapeElement('rect', { id: 'a', x: 100, y: 100, width: 100, height: 50, rotation: 30, fill: '#ff0000' }),
      createShapeElement('rect', { id: 'b', x: 300, y: 300, width: 80, height: 80, rotation: 30, fill: '#00ff00' }),
    ];
    c.store.getState().actions.openDocument(doc);
    await c.controller.ready();
    c.store.getState().actions.select(['a', 'b']);
    const tr = c.controller.transformer;
    expect(tr.keepRatio()).toBe(true);
    tr.fire('transformstart');
    for (const n of tr.nodes()) n.setAttrs({ rotation: 75 });
    tr.fire('transformend');
    // committed (not skipped as skew), in the screen-faithful frame space
    expect(Math.abs(el(c.store, 'a').rotation - 75)).toBeLessThan(0.05);
    expect(Math.abs(el(c.store, 'b').rotation - 75)).toBeLessThan(0.05);
    expect(el(c.store, 'a').width).toBe(100);
    expect(c.store.getState().undoLabel).toBe('Rotate');
  });
});

describe('WorkspaceController: reconciliation', () => {
  it('applies store changes to the scenes (update, add/remove pages, undo)', async () => {
    const c = await setup();
    const a = c.store.getState().actions;
    a.updateElement('r1', { fill: '#123456' });
    expectParity(c, 0, 1);
    const newPage = a.addPage();
    expect(c.controller.getScene(newPage)).toBeDefined();
    expect(c.controller.contentLayer.getChildren()).toHaveLength(3);
    a.deletePage(newPage);
    expect(c.controller.getScene(newPage)).toBeUndefined();
    expect(c.controller.contentLayer.getChildren()).toHaveLength(2);
    a.undo(); // page back
    expect(c.controller.getScene(newPage)).toBeDefined();
    a.deleteElements(['r1'], { force: true });
    expect(c.controller.getElementNode('r1')).toBeUndefined();
    a.undo();
    expect(c.controller.getElementNode('r1')).toBeDefined();
    expectParity(c, 0, 1);
  });

  it('loads images for newly inserted assets and redraws them', async () => {
    const c = await setup();
    const a = c.store.getState().actions;
    const id = a.addImage({ src: '/uploads/other.png', width: 300, height: 300, mimeType: 'image/png' });
    await c.controller.ready();
    expect(c.env.imageLoads).toBe(2);
    expect(c.controller.getElementNode(id)).toBeDefined();
    expectParity(c, 0, 1);
  });

  it('a new document rebuilds everything', async () => {
    const c = await setup();
    const doc = createDocument('instagram-post');
    doc.pages[0]!.elements = [createShapeElement('rect', { id: 'n1', x: 10, y: 10, width: 10, height: 10, fill: '#000000' })];
    c.store.getState().actions.openDocument(doc);
    await c.controller.ready();
    expect(c.controller.getScene(doc.pages[0]!.id)).toBeDefined();
    expect(c.controller.contentLayer.getChildren()).toHaveLength(1);
    expectParity(c, 0, 1);
  });
});

describe('WorkspaceController: modes', () => {
  it('double-click on text starts inline editing and hides the Konva node while editing', async () => {
    const c = await setup();
    c.controller.doubleClick(at(c, 450, 470));
    expect(c.store.getState().textEditingId).toBe('t1');
    expect(c.controller.getElementNode('t1')!.visible()).toBe(false);
    expect(c.controller.transformer.nodes()).toHaveLength(0);
    const g = c.controller.getTextEditGeometry('t1')!;
    expect(g.zoom).toBe(c.controller.getView().zoom);
    expect(g.pageOrigin).toEqual(at(c, 0, 0));
    const m = c.controller.measureText({ ...(el(c.store, 't1') as TextElement), content: 'a\nb\nc' });
    expect(m.height).toBeGreaterThan(100);
    c.store.getState().actions.stopTextEditing();
    expect(c.controller.getElementNode('t1')!.visible()).toBe(true);
    expectParity(c, 0, 1);
  });

  it('autoGrowText grows the box to the measured text (merged undo step)', async () => {
    const c = await setup();
    const a = c.store.getState().actions;
    a.setTextContent('t1', 'one\ntwo\nthree');
    expect(c.controller.autoGrowText('t1')).toBe(true);
    expect(el(c.store, 't1').height).toBeGreaterThan(60);
    a.undo();
    expect(el(c.store, 't1').height).toBe(60);
    expect((el(c.store, 't1') as { content: string }).content).toBe('Hello Plakat');
  });

  it('refits the text box after panel edits of layout fields (grow only, same undo step)', async () => {
    const c = await setup();
    const a = c.store.getState().actions;
    a.updateElement('t1', { fontSize: 120 }, { label: 'Font size' });
    await Promise.resolve();
    const t1 = el(c.store, 't1') as TextElement;
    const m = c.controller.measureText(t1);
    expect(m.height).toBeGreaterThan(60);
    expect(t1.height).toBeCloseTo(Math.ceil(m.height * 100) / 100, 6);
    expect(c.store.getState().undoLabel).toBe('Font size');
    a.undo();
    await Promise.resolve();
    expect(el(c.store, 't1')).toMatchObject({ fontSize: 40, height: 60 });
    // Undo never triggers a refit commit (that would drop the redo stack).
    expect(c.store.getState().canRedo).toBe(true);
    a.redo();
    expect(el(c.store, 't1').height).toBeCloseTo(t1.height, 6);
    a.undo();
    // Shrinking the font never shrinks the box (vertical alignment uses the extra height).
    a.updateElement('t1', { fontSize: 10 });
    await Promise.resolve();
    expect(el(c.store, 't1').height).toBe(60);
    // Other text edits (bold, font family) refit too.
    a.updateElement('t1', { content: 'one two three four five six seven eight nine ten', fontSize: 40 });
    await Promise.resolve();
    expect(el(c.store, 't1').height).toBeGreaterThan(60);
  });

  it('double-click remembers the click point for the inline editor caret (consumed once)', async () => {
    const c = await setup();
    const p = at(c, 450, 470);
    c.controller.doubleClick(p);
    expect(c.store.getState().textEditingId).toBe('t1');
    expect(c.controller.takeTextEditCaret('t1')).toEqual(p);
    expect(c.controller.takeTextEditCaret('t1')).toBeNull();
  });

  it('crop mode: ghost + crop rect, Enter/exit applies the crop', async () => {
    const c = await setup();
    c.controller.doubleClick(at(c, 700, 750));
    expect(c.store.getState().cropModeId).toBe('i1');
    const state = c.controller.getCropState()!;
    // cover of 400×200 into 200×200: k = 1, ghost = (-100, 0, 400, 200)
    expect(state.session.ghost.x).toBeCloseTo(-100, 6);
    expect(c.controller.getElementNode('i1')!.visible()).toBe(false);
    c.controller.setCropRect({ x: -500, y: 0, width: 200, height: 200 }); // clamped to the image
    expect(c.controller.getCropState()!.rect.x).toBeCloseTo(-100, 6);
    expect(c.controller.handleEnter()).toBe(true);
    await Promise.resolve();
    const i1 = el(c.store, 'i1') as ImageElement;
    expect(i1.crop).not.toBeNull();
    expect(i1.crop!.x).toBeCloseTo(0, 6);
    expect(i1.crop!.width).toBeCloseTo(200, 6);
    expect(i1.width).toBe(200); // box size kept
    expect(c.controller.getElementNode('i1')!.visible()).toBe(true);
    expectParity(c, 0, 1);
  });

  it('Escape cancels the crop edit', async () => {
    const c = await setup();
    c.store.getState().actions.enterCropMode('i1');
    c.controller.setCropRect({ x: 50, y: 0, width: 100, height: 100 });
    expect(c.controller.cancelCrop()).toBe(true);
    await Promise.resolve();
    expect(c.store.getState().cropModeId).toBeNull();
    expect((el(c.store, 'i1') as ImageElement).crop).toBeNull();
    expect(c.controller.cancelCrop()).toBe(false);
  });

  it('snapshotPage returns PNG bytes of the editor scene', async () => {
    const c = await setup();
    c.controller.setPan(-123, 77, { clamp: false });
    const bytes = await c.controller.snapshotPage(c.store.getState().document.pages[0]!.id, 1);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('WorkspaceController: late fonts', () => {
  it('rebuilds text and clears missingFonts when a font arrives after the barrier gave up', async () => {
    const doc = fixtureDoc();
    const t1 = doc.pages[0]!.elements.find((e) => e.id === 't1') as TextElement;
    t1.fontFamily = 'Playfair Display';
    const store = createEditorStore({ document: doc });
    const env = testEnv();
    let available = false;
    const label = '"Playfair Display" normal 400';
    env.loadFonts = async () => {
      if (!available) throw new FontLoadError([label], 'Font loading timed out');
    };
    const statuses: string[][] = [];
    const controller = new WorkspaceController({ host: makeHost(), store, env, devicePixelRatio: () => 1, onStatus: (st) => statuses.push(st.missingFonts) });
    live.push(controller);
    await controller.ready();
    expect(controller.getStatus().missingFonts).toEqual([label]);
    expect(await controller.retryMissingFonts()).toEqual([]);
    expect(controller.getStatus().missingFonts).toEqual([label]);
    const before = controller.getElementNode('t1')!.findOne('Text');
    available = true;
    expect(await controller.retryMissingFonts()).toEqual([label]);
    expect(controller.getStatus().missingFonts).toEqual([]);
    expect(statuses.at(-1)).toEqual([]);
    // The text node was rebuilt (fresh measurement with the real face).
    expect(controller.getElementNode('t1')!.findOne('Text')).not.toBe(before);
  });
});
