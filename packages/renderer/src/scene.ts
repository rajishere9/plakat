import {
  applyTextTransform,
  computeImageLayout,
  exportPixelSize,
  getShapePoints,
  type Asset,
  type Id,
  type ImageElement,
  type Page,
  type PageSize,
  type PlakatDocument,
  type PlakatElement,
  type ShapeElement,
  type TextElement,
} from '@plakat/schema';
import { applyFilterAttrs, syncFilterCache } from './filters.ts';
import {
  Konva,
  type KonvaContext,
  type KonvaGroup,
  type KonvaImage,
  type KonvaNode,
  type KonvaShape,
  type KonvaText,
} from './konva.ts';
import { invalidateTextMeasurements, widestGraphemeWidth } from './text.ts';
import type { DecodedImage, Resources } from './types.ts';

// ---------------------------------------------------------------------------
// Node names (stable: the editor's hit testing relies on them)
// ---------------------------------------------------------------------------

/** `name()` of PageScene.root. The root also carries attr `plakatPageId`. */
export const PAGE_ROOT_NAME = 'plakat-page-root';
/** `name()` of the content group (the root's only child). */
export const PAGE_CONTENT_NAME = 'plakat-page-content';
export const PAGE_BACKGROUND_NAME = 'plakat-page-background';
export const PAGE_BACKGROUND_IMAGE_NAME = 'plakat-page-background-image';
/** `name()` of every top-level element node (a Konva.Group whose `id()` is the element id). */
export const ELEMENT_NODE_NAME = 'element';
/** Invisible box (element-local 0,0,width,height) used only for hit testing / Transformer bounds. */
export const ELEMENT_HITBOX_NAME = 'element-hitbox';
/** Inner group of image elements carrying the flip transform. */
export const IMAGE_FLIP_NAME = 'element-image-flip';
/** Checkerboard drawn for an image whose asset is missing (editor only; export refuses). */
export const ASSET_PLACEHOLDER_NAME = 'element-asset-placeholder';

/** Number of content-group children below the element nodes (background rect + image). */
const BACKGROUND_NODE_COUNT = 2;

// ---------------------------------------------------------------------------
// applyElement: THE element -> Konva mapping (§3). Fresh build and update both use it.
// ---------------------------------------------------------------------------

/** Everything applyElement needs besides the element itself. */
export interface ApplyContext {
  assets: PlakatDocument['assets'];
  resources: Resources;
  /** Effective output pixel ratio: filter caches are made at this ratio (P-7). */
  pixelRatio: number;
}

function getAsset(assets: PlakatDocument['assets'], id: Id): Asset | undefined {
  return Object.hasOwn(assets, id) ? assets[id] : undefined;
}

const noopSceneFunc = () => {};

function createHitbox(): KonvaShape {
  const hitbox = new Konva.Rect({ name: ELEMENT_HITBOX_NAME, fill: '#000000' });
  // Never paints (pixel-exact no-op); only participates in hit testing and bounds.
  hitbox.sceneFunc(noopSceneFunc);
  hitbox.hitFunc((ctx: KonvaContext, shape: KonvaShape) => {
    ctx.beginPath();
    ctx.rect(0, 0, shape.width(), shape.height());
    ctx.closePath();
    ctx.fillStrokeShape(shape);
  });
  return hitbox;
}

/** Creates the node skeleton for an element and applies it. */
export function createElementNode(el: PlakatElement, ctx: ApplyContext): KonvaGroup {
  const group = new Konva.Group();
  group.add(createHitbox());
  if (el.type === 'image') group.add(new Konva.Group({ name: IMAGE_FLIP_NAME }));
  applyElement(group, el, ctx);
  return group;
}

/**
 * Applies an element to its node, setting EVERY attribute the renderer owns (so an update
 * produces exactly the attributes of a fresh build, §2.2). The node must have been made
 * by createElementNode for an element of the same `type`.
 */
export function applyElement(group: KonvaGroup, el: PlakatElement, ctx: ApplyContext): void {
  group.setAttrs({
    id: el.id,
    name: ELEMENT_NODE_NAME,
    x: el.x,
    y: el.y,
    rotation: el.rotation,
    opacity: el.opacity,
    visible: !el.hidden,
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    skewX: 0,
    skewY: 0,
  });
  group.setAttr('plakatType', el.type);
  const hitbox = group.getChildren()[0] as KonvaShape;
  hitbox.setAttrs({ x: 0, y: 0, width: el.width, height: el.height });
  switch (el.type) {
    case 'text':
      applyText(group, el);
      break;
    case 'shape':
      applyShape(group, el);
      break;
    case 'image':
      applyImage(group, el, ctx);
      break;
  }
}

function replaceBody<T extends KonvaGroup | KonvaShape>(parent: KonvaGroup, index: number, create: () => T, is: (n: KonvaNode) => boolean): T {
  const children = parent.getChildren();
  const current = children[index];
  if (current && is(current)) return current as unknown as T;
  current?.destroy();
  const node = create();
  parent.add(node);
  node.zIndex(Math.min(index, parent.getChildren().length - 1));
  return node;
}

function applyText(group: KonvaGroup, el: TextElement): void {
  const node = replaceBody<KonvaText>(group, 1, () => new Konva.Text({ text: '' }), (n) => n instanceof Konva.Text);
  const text = applyTextTransform(el.content, el.textTransform);
  const letterSpacing = el.letterSpacing * el.fontSize;
  node.setAttrs({
    x: 0,
    text,
    fontFamily: el.fontFamily,
    fontStyle: `${el.fontStyle} ${el.fontWeight}`,
    fontVariant: 'normal',
    fontSize: el.fontSize,
    lineHeight: el.lineHeight,
    letterSpacing,
    align: el.align,
    verticalAlign: 'top',
    direction: 'inherit',
    fill: el.fill,
    textDecoration: el.textDecoration === 'none' ? '' : el.textDecoration,
    wrap: 'word',
    ellipsis: false,
    padding: 0,
    listening: true,
  });
  // §3.3: never narrower than its widest grapheme (Konva drops text otherwise), no height.
  node.width(Math.max(el.width, widestGraphemeWidth(node, text, letterSpacing)));
  // P-5: vertical alignment computed from the measured (auto) height.
  const h = node.height();
  const free = el.height - h;
  node.y(free <= 0 ? 0 : el.verticalAlign === 'middle' ? free / 2 : el.verticalAlign === 'bottom' ? free : 0);
}

function shapeClass(shape: ShapeElement['shape']) {
  return shape === 'rect' ? Konva.Rect : shape === 'ellipse' ? Konva.Ellipse : Konva.Line;
}

function applyShape(group: KonvaGroup, el: ShapeElement): void {
  const Cls = shapeClass(el.shape);
  const node = replaceBody<KonvaShape>(group, 1, () => new Cls(), (n) => n.constructor === Cls);
  const isLine = el.shape === 'line';
  node.setAttrs({
    fill: isLine ? undefined : (el.fill ?? undefined),
    stroke: el.stroke ?? undefined,
    strokeWidth: el.strokeWidth,
    dash: [...el.dash],
    lineJoin: 'miter',
    lineCap: 'butt',
    strokeScaleEnabled: true,
    listening: true,
  });
  const w = el.width;
  const h = el.height;
  if (el.shape === 'rect') {
    node.setAttrs({ x: 0, y: 0, width: w, height: h, cornerRadius: el.cornerRadius });
  } else if (el.shape === 'ellipse') {
    node.setAttrs({ x: w / 2, y: h / 2, radiusX: w / 2, radiusY: h / 2 });
  } else {
    node.setAttrs({
      x: 0,
      y: 0,
      points: getShapePoints(el.shape, w, h, el.sides, el.innerRadius) ?? [],
      closed: !isLine,
      tension: 0,
    });
  }
}

function drawCheckerboard(ctx: KonvaContext, shape: KonvaShape): void {
  const w = shape.width();
  const h = shape.height();
  const cell = Math.max(4, Math.min(w, h) / 8);
  const c = ctx._context;
  c.save();
  c.beginPath();
  c.rect(0, 0, w, h);
  c.clip();
  c.fillStyle = '#e6e6e6';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#c8c8c8';
  for (let y = 0, row = 0; y < h; y += cell, row++) {
    for (let x = row % 2 ? cell : 0; x < w; x += cell * 2) c.fillRect(x, y, cell, cell);
  }
  c.restore();
}

function applyImage(group: KonvaGroup, el: ImageElement, ctx: ApplyContext): void {
  const flip = group.getChildren()[1] as KonvaGroup;
  flip.setAttrs({
    x: el.flipX ? el.width : 0,
    y: el.flipY ? el.height : 0,
    scaleX: el.flipX ? -1 : 1,
    scaleY: el.flipY ? -1 : 1,
    rotation: 0,
    opacity: 1,
  });
  const asset = getAsset(ctx.assets, el.assetId);
  const decoded = asset ? ctx.resources.images.get(el.assetId) : undefined;
  if (asset && decoded) {
    const node = replaceBody<KonvaImage>(flip, 0, () => new Konva.Image({ image: undefined }), (n) => n instanceof Konva.Image);
    const { crop, dest } = computeImageLayout(el, asset, { width: decoded.width, height: decoded.height });
    node.setAttrs({
      image: decoded,
      x: dest.x,
      y: dest.y,
      width: dest.width,
      height: dest.height,
      cropX: crop.x,
      cropY: crop.y,
      cropWidth: crop.width,
      cropHeight: crop.height,
      cornerRadius: el.cornerRadius,
      listening: true,
    });
    applyFilterAttrs(node, el.filters);
    syncFilterCache(node, ctx.pixelRatio);
    group.setAttr('plakatImage', decoded);
  } else {
    const node = replaceBody<KonvaShape>(
      flip,
      0,
      () => new Konva.Shape({ name: ASSET_PLACEHOLDER_NAME, sceneFunc: drawCheckerboard }),
      (n) => n.name() === ASSET_PLACEHOLDER_NAME,
    );
    node.setAttrs({ x: 0, y: 0, width: el.width, height: el.height });
    group.setAttr('plakatImage', null);
  }
  group.setAttr('plakatAsset', asset ?? null);
}

// ---------------------------------------------------------------------------
// PageScene
// ---------------------------------------------------------------------------

export interface PageSceneOptions {
  doc: PlakatDocument;
  pageId: Id;
  resources: Resources;
  /** Effective output pixel ratio: `s` for export, `zoom × devicePixelRatio` on screen. */
  pixelRatio: number;
}

export interface PageSceneUpdateOptions {
  /** Re-apply these elements even if reference-equal (after every dragend/transformend). */
  dirty?: Iterable<Id>;
  /** Destroy + rebuild these text nodes (or all with `true`) after late font loads. */
  rebuildText?: true | Iterable<Id>;
  /** New resources (e.g. after loading a newly inserted image). Image nodes whose decoded image changed are re-applied. */
  resources?: Resources;
}

function findPage(doc: PlakatDocument, pageId: Id): Page {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`Page "${pageId}" is not in the document`);
  return page;
}

function assertPixelRatio(r: number): void {
  if (!(Number.isFinite(r) && r > 0)) throw new RangeError(`Invalid pixel ratio: ${String(r)}`);
}

/**
 * The one imperative scene builder (P-1): maps one page of a document to Konva nodes,
 * and patches them incrementally (reconciliation by element id, §2.2).
 *
 *   root (Group, ALWAYS x=0 y=0 scale=1 opacity=1; attr plakatPageId)
 *   └─ content (Group, scale = contentScaleX/Y, clip = page box)
 *      ├─ background rect   (visible iff background.color != null)
 *      ├─ background image  (visible iff background.image resolves)
 *      └─ element nodes (Group id=element.id name='element'), in z-order
 */
export class PageScene {
  readonly root: KonvaGroup;
  readonly pageId: Id;
  private readonly content: KonvaGroup;
  private readonly bgRect: KonvaShape;
  private readonly bgImage: KonvaImage;
  private readonly nodes = new Map<Id, KonvaGroup>();
  private readonly elements = new Map<Id, PlakatElement>();
  private doc: PlakatDocument;
  private page: Page;
  private resources: Resources;
  private ratio: number;
  private bgState: { asset: Asset | null; image: DecodedImage | null } = { asset: null, image: null };
  private destroyed = false;

  constructor(opts: PageSceneOptions) {
    assertPixelRatio(opts.pixelRatio);
    this.doc = opts.doc;
    this.pageId = opts.pageId;
    this.page = findPage(opts.doc, opts.pageId);
    this.resources = opts.resources;
    this.ratio = opts.pixelRatio;
    this.root = new Konva.Group({ name: PAGE_ROOT_NAME, x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1 });
    this.root.setAttr('plakatPageId', opts.pageId);
    this.content = new Konva.Group({ name: PAGE_CONTENT_NAME });
    this.root.add(this.content);
    this.bgRect = new Konva.Rect({ name: PAGE_BACKGROUND_NAME });
    this.bgImage = new Konva.Image({ name: PAGE_BACKGROUND_IMAGE_NAME, image: undefined });
    this.content.add(this.bgRect, this.bgImage);
    this.applyContentTransform();
    this.applyBackground();
    const ctx = this.ctx();
    for (const el of this.page.elements) {
      const node = createElementNode(el, ctx);
      this.content.add(node);
      this.nodes.set(el.id, node);
      this.elements.set(el.id, el);
    }
  }

  /** The (shared) page size of the current document. */
  get size(): PageSize {
    return this.doc.size;
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  /** The document the scene currently reflects. */
  get document(): PlakatDocument {
    return this.doc;
  }

  /** The element node (Konva.Group, id = element id) or undefined. */
  getElementNode(id: Id): KonvaGroup | undefined {
    return this.nodes.get(id);
  }

  /** Element ids in z-order (bottom first). */
  getElementIds(): Id[] {
    return this.page.elements.map((e) => e.id);
  }

  private ctx(): ApplyContext {
    return { assets: this.doc.assets, resources: this.resources, pixelRatio: this.ratio };
  }

  private applyContentTransform(): void {
    const { width, height } = this.doc.size;
    const px = exportPixelSize({ width, height }, this.ratio);
    this.content.setAttrs({
      x: 0,
      y: 0,
      scaleX: px.contentScaleX,
      scaleY: px.contentScaleY,
      rotation: 0,
      opacity: 1,
      clipX: 0,
      clipY: 0,
      clipWidth: width,
      clipHeight: height,
    });
  }

  private applyBackground(): void {
    const { width, height } = this.doc.size;
    const bg = this.page.background;
    this.bgRect.setAttrs({ x: 0, y: 0, width, height, fill: bg.color ?? undefined, visible: bg.color !== null });
    const assetId = bg.image?.assetId;
    const asset = assetId !== undefined ? (getAsset(this.doc.assets, assetId) ?? null) : null;
    const decoded = asset && assetId !== undefined ? (this.resources.images.get(assetId) ?? null) : null;
    if (asset && decoded) {
      const { crop, dest } = computeImageLayout({ width, height, crop: null, objectFit: 'cover' }, asset, {
        width: decoded.width,
        height: decoded.height,
      });
      this.bgImage.setAttrs({
        image: decoded,
        x: dest.x,
        y: dest.y,
        width: dest.width,
        height: dest.height,
        cropX: crop.x,
        cropY: crop.y,
        cropWidth: crop.width,
        cropHeight: crop.height,
        visible: true,
      });
    } else {
      this.bgImage.setAttrs({ image: undefined, visible: false });
    }
    this.bgState = { asset, image: decoded };
  }

  private backgroundStale(): boolean {
    const assetId = this.page.background.image?.assetId;
    if (assetId === undefined) return this.bgState.asset !== null;
    const asset = getAsset(this.doc.assets, assetId) ?? null;
    const decoded = asset ? (this.resources.images.get(assetId) ?? null) : null;
    return asset !== this.bgState.asset || decoded !== this.bgState.image;
  }

  private imageStale(node: KonvaGroup, el: ImageElement): boolean {
    const asset = getAsset(this.doc.assets, el.assetId) ?? null;
    const decoded = asset ? (this.resources.images.get(el.assetId) ?? null) : null;
    return node.getAttr('plakatAsset') !== asset || node.getAttr('plakatImage') !== decoded;
  }

  /**
   * Reconcile with a new document version (§2.2): re-apply changed (or `dirty`) elements,
   * create new ones, rebuild text nodes listed in `rebuildText`, fix z-order, destroy
   * removed ones, re-apply background / content transform when needed, then batchDraw().
   */
  update(doc: PlakatDocument, opts: PageSceneUpdateOptions = {}): void {
    if (this.destroyed) throw new Error('PageScene was destroyed');
    const page = findPage(doc, this.pageId);
    const prevDoc = this.doc;
    const prevPage = this.page;
    if (opts.resources) this.resources = opts.resources;
    const dirty = new Set(opts.dirty ?? []);
    const rebuildAll = opts.rebuildText === true;
    const rebuild = new Set(opts.rebuildText === true || opts.rebuildText === undefined ? [] : opts.rebuildText);
    if (rebuildAll || rebuild.size > 0) invalidateTextMeasurements();
    const sizeChanged = doc.size.width !== prevDoc.size.width || doc.size.height !== prevDoc.size.height;
    this.doc = doc;
    this.page = page;
    const ctx = this.ctx();

    const seen = new Set<Id>();
    for (const el of page.elements) {
      seen.add(el.id);
      let node = this.nodes.get(el.id);
      const prev = this.elements.get(el.id);
      const mustRebuild = el.type === 'text' && (rebuildAll || rebuild.has(el.id));
      if (node && (prev?.type !== el.type || mustRebuild)) {
        node.destroy();
        node = undefined;
      }
      if (!node) {
        node = createElementNode(el, ctx);
        this.content.add(node);
        this.nodes.set(el.id, node);
      } else if (prev !== el || dirty.has(el.id) || (el.type === 'image' && this.imageStale(node, el))) {
        applyElement(node, el, ctx);
      }
      this.elements.set(el.id, el);
    }
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      node.destroy();
      this.nodes.delete(id);
      this.elements.delete(id);
    }
    page.elements.forEach((el, i) => {
      const node = this.nodes.get(el.id)!;
      if (node.zIndex() !== i + BACKGROUND_NODE_COUNT) node.zIndex(i + BACKGROUND_NODE_COUNT);
    });
    if (sizeChanged) this.applyContentTransform();
    if (sizeChanged || page.background !== prevPage.background || this.backgroundStale()) this.applyBackground();
    this.root.getLayer()?.batchDraw();
  }

  /**
   * Switch the effective output pixel ratio: content scale (P-8) and filter caches (P-7).
   * A no-op when the ratio is unchanged.
   */
  setPixelRatio(pixelRatio: number): void {
    assertPixelRatio(pixelRatio);
    if (pixelRatio === this.ratio) return;
    this.ratio = pixelRatio;
    this.applyContentTransform();
    for (const node of this.nodes.values()) {
      if (node.getAttr('plakatType') !== 'image') continue;
      const img = (node.getChildren()[1] as KonvaGroup | undefined)?.getChildren()[0];
      if (img instanceof Konva.Image) syncFilterCache(img, pixelRatio);
    }
    this.root.getLayer()?.batchDraw();
  }

  /** Destroys every node (and releases filter caches). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.destroy();
    this.nodes.clear();
    this.elements.clear();
  }
}
