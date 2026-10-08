import type { Id } from '@plakat/schema';
import { Konva, type KonvaGroup, type KonvaNode } from './konva.ts';
import { ELEMENT_NODE_NAME, PAGE_ROOT_NAME, type PageScene } from './scene.ts';

/**
 * Editor integration (render-export-pipeline.md §2.1, P-12):
 *
 *   stage (zoom = stage.scale(), pan = stage.position())
 *   ├─ content layer
 *   │   ├─ page frame (Group at the page's on-screen offset, opacity 1, no cache/filters)
 *   │   │   └─ scene.root              ← mountPageScene(frame, scene)
 *   │   └─ page frame … (one per visible page)
 *   └─ chrome layer (Transformer, guides, hover/selection outlines …; never exported)
 *
 * Create each scene with `pixelRatio = zoom × devicePixelRatio`, call
 * `scene.setPixelRatio(zoom × dpr)` (debounced ~150 ms) after zoom changes, and
 * `scene.update(doc, { dirty: touchedIds })` after every dragend/transformend.
 * Export / thumbnails of the editor's own scene: `rasterizePage(scene, s)`.
 * Never call stage.toCanvas()/layer.toCanvas() for exports.
 */

export const PAGE_FRAME_NAME = 'plakat-page-frame';

/** A page frame: a plain Group at the page's on-screen offset (in stage/world units). */
export function createPageFrame(opts: { x: number; y: number; pageId?: Id }): KonvaGroup {
  const frame = new Konva.Group({ name: PAGE_FRAME_NAME, x: opts.x, y: opts.y, opacity: 1 });
  if (opts.pageId !== undefined) frame.setAttr('plakatPageId', opts.pageId);
  return frame;
}

/**
 * Puts `scene.root` into `frame` (which must hold nothing else) and returns a function
 * that detaches it again (without destroying the scene).
 */
export function mountPageScene(frame: KonvaGroup, scene: PageScene): () => void {
  const others = frame.getChildren().filter((c) => c !== scene.root);
  if (others.length > 0) throw new Error('A page frame must hold exactly one PageScene root and nothing else');
  if (frame.opacity() !== 1) throw new Error('A page frame must not carry opacity');
  if (scene.root.getParent() !== frame) frame.add(scene.root);
  frame.setAttr('plakatPageId', scene.pageId);
  frame.getLayer()?.batchDraw();
  return () => {
    if (scene.root.getParent() === frame) scene.root.remove();
  };
}

/**
 * The top-level element node (Konva.Group, `name('element')`, `id()` = element id) that
 * contains `node`, or null (background, chrome, or outside any PageScene).
 */
export function getElementNodeFromNode(node: KonvaNode | null | undefined): KonvaGroup | null {
  let n: KonvaNode | null | undefined = node;
  while (n) {
    if (n.hasName(PAGE_ROOT_NAME)) return null;
    if (n.hasName(ELEMENT_NODE_NAME) && n instanceof Konva.Group) return n;
    n = n.getParent();
  }
  return null;
}

/** Element id for a hit node (e.g. `stage.getIntersection(pos)` or an event target), or null. */
export function getElementIdFromNode(node: KonvaNode | null | undefined): Id | null {
  const el = getElementNodeFromNode(node);
  return el ? el.id() : null;
}

/** Page id of the PageScene that contains `node`, or null. */
export function getPageIdFromNode(node: KonvaNode | null | undefined): Id | null {
  let n: KonvaNode | null | undefined = node;
  while (n) {
    if (n.hasName(PAGE_ROOT_NAME)) return (n.getAttr('plakatPageId') as Id | undefined) ?? null;
    n = n.getParent();
  }
  return null;
}

/** Effective on-screen pixel ratio for a scene: zoom × devicePixelRatio. */
export function editorPixelRatio(zoom: number, devicePixelRatio: number = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1): number {
  return zoom * devicePixelRatio;
}
