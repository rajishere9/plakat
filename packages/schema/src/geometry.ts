import type { CropRect, ImageElement, PlakatElement, ShapeKind } from './types.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Any element-like box: (x, y) is the local origin; rotation (deg, clockwise) is about that origin. */
export interface Box extends Rect {
  rotation: number;
}

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Normalizes degrees to [0, 360). */
export function normalizeRotation(deg: number): number {
  const r = deg % 360;
  const n = r < 0 ? r + 360 : r;
  return n === 360 || Object.is(n, -0) ? 0 : n;
}

/** Rotates `p` clockwise (screen coordinates, y down) by `deg` around `origin`. */
export function rotatePoint(p: Point, origin: Point, deg: number): Point {
  const rad = degToRad(deg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/** Maps a point in the element's local (unrotated) space to page space. */
export function localToPage(box: Box, local: Point): Point {
  return rotatePoint({ x: box.x + local.x, y: box.y + local.y }, { x: box.x, y: box.y }, box.rotation);
}

/** Corners in page space: [top-left, top-right, bottom-right, bottom-left] of the local box. */
export function getElementCorners(box: Box): [Point, Point, Point, Point] {
  return [
    localToPage(box, { x: 0, y: 0 }),
    localToPage(box, { x: box.width, y: 0 }),
    localToPage(box, { x: box.width, y: box.height }),
    localToPage(box, { x: 0, y: box.height }),
  ];
}

export function getElementCenter(box: Box): Point {
  return localToPage(box, { x: box.width / 2, y: box.height / 2 });
}

/** Axis-aligned bounding box of a (possibly rotated) element, in page space. */
export function getElementBounds(box: Box): Rect {
  return getPointsBounds(getElementCorners(box));
}

export function getPointsBounds(points: readonly Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Union AABB of several elements (null for an empty list). */
export function getSelectionBounds(boxes: readonly Box[]): Rect | null {
  if (boxes.length === 0) return null;
  return getPointsBounds(boxes.flatMap((b) => getElementCorners(b)));
}

/**
 * Returns the {x, y, rotation} that rotates the element to `rotation` while keeping its
 * visual center fixed (what the rotation input in the properties panel does).
 */
export function rotateAroundCenter(box: Box, rotation: number): { x: number; y: number; rotation: number } {
  const center = getElementCenter(box);
  const origin = rotatePoint({ x: center.x - box.width / 2, y: center.y - box.height / 2 }, center, rotation);
  return { x: origin.x, y: origin.y, rotation };
}

/**
 * Returns the {x, y} that places the element's AABB top-left at `target` (used by
 * align-to-page / align-to-selection on rotated elements).
 */
export function moveBoundsTo(box: Box, target: Point): { x: number; y: number } {
  const b = getElementBounds(box);
  return { x: box.x + (target.x - b.x), y: box.y + (target.y - b.y) };
}

export interface SnapEdges {
  /** [left, centerX, right] */
  x: [number, number, number];
  /** [top, centerY, bottom] */
  y: [number, number, number];
}

/** Snap candidate lines of a rect (snapping operates on AABBs). */
export function getSnapEdges(rect: Rect): SnapEdges {
  return {
    x: [rect.x, rect.x + rect.width / 2, rect.x + rect.width],
    y: [rect.y, rect.y + rect.height / 2, rect.y + rect.height],
  };
}

/**
 * Local-space polygon points (flat [x0, y0, x1, y1, ...]) for polygonal shapes, fitted to
 * the box so the polygon's own AABB is exactly (0, 0, width, height).
 *  - triangle: apex top-center, base along the bottom edge.
 *  - polygon:  regular n-gon (first vertex at top), scaled non-uniformly to the box.
 *  - star:     n-point star with inner radius ratio, first point at top, fitted the same way.
 *  - line:     two points through the vertical center: [0, h/2, w, h/2].
 * Returns null for rect/ellipse (drawn natively).
 */
export function getShapePoints(
  shape: ShapeKind,
  width: number,
  height: number,
  sides = 5,
  innerRadius = 0.5,
): number[] | null {
  switch (shape) {
    case 'rect':
    case 'ellipse':
      return null;
    case 'line':
      return [0, height / 2, width, height / 2];
    case 'triangle':
      return [width / 2, 0, width, height, 0, height];
    case 'polygon':
    case 'star': {
      const raw: Point[] = [];
      const n = Math.max(3, Math.round(sides));
      const count = shape === 'star' ? n * 2 : n;
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
        const r = shape === 'star' && i % 2 === 1 ? innerRadius : 1;
        raw.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
      }
      const b = getPointsBounds(raw);
      const sx = b.width === 0 ? 0 : width / b.width;
      const sy = b.height === 0 ? 0 : height / b.height;
      return raw.flatMap((p) => [(p.x - b.x) * sx, (p.y - b.y) * sy]);
    }
  }
}

export interface Size {
  width: number;
  height: number;
}

export interface ImageLayout {
  /** Source rect to sample, in the DECODED bitmap's pixels (pass straight to Konva `crop`). Never degenerate. */
  crop: CropRect;
  /** Destination rect in element-local px (inside 0..width, 0..height). */
  dest: Rect;
}

/**
 * Resolves how an image element samples its source. All crop math happens in the
 * asset's DECLARED pixel space (`asset.width/height`, the space `el.crop` is stored
 * in); the result is then scaled to the decoded bitmap (`decoded`, default = declared),
 * so a different-resolution rendition (re-encoded upload, provider thumbnail) samples
 * the same region.
 *  - crop != null  -> that crop (clamped to the image), stretched to the full box;
 *                     a crop that clamps to zero width/height falls back to `cover`.
 *  - fill          -> whole image stretched to the box.
 *  - cover         -> centered crop with the box's aspect ratio, full box.
 *  - contain       -> whole image, letterboxed & centered inside the box.
 */
export function computeImageLayout(
  el: Pick<ImageElement, 'width' | 'height' | 'crop' | 'objectFit'>,
  asset: Size,
  decoded: Size = asset,
): ImageLayout {
  const layout = layoutInAssetSpace(el, asset.width, asset.height);
  const kx = asset.width > 0 ? decoded.width / asset.width : 1;
  const ky = asset.height > 0 ? decoded.height / asset.height : 1;
  if (kx === 1 && ky === 1) return layout;
  const c = layout.crop;
  return { crop: { x: c.x * kx, y: c.y * ky, width: c.width * kx, height: c.height * ky }, dest: layout.dest };
}

function layoutInAssetSpace(
  el: Pick<ImageElement, 'width' | 'height' | 'crop' | 'objectFit'>,
  naturalWidth: number,
  naturalHeight: number,
): ImageLayout {
  const full: Rect = { x: 0, y: 0, width: el.width, height: el.height };
  if (el.crop) {
    const x = clamp(el.crop.x, 0, naturalWidth);
    const y = clamp(el.crop.y, 0, naturalHeight);
    const width = Math.min(el.crop.width, naturalWidth - x);
    const height = Math.min(el.crop.height, naturalHeight - y);
    // Konva treats a falsy cropWidth/cropHeight as "no crop" and would draw the WHOLE image.
    if (width > 0 && height > 0) return { crop: { x, y, width, height }, dest: full };
    return layoutInAssetSpace({ ...el, crop: null, objectFit: 'cover' }, naturalWidth, naturalHeight);
  }
  const whole: CropRect = { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
  if (el.objectFit === 'fill' || el.width <= 0 || el.height <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return { crop: whole, dest: full };
  }
  const boxAspect = el.width / el.height;
  const imgAspect = naturalWidth / naturalHeight;
  if (el.objectFit === 'cover') {
    if (imgAspect > boxAspect) {
      const w = naturalHeight * boxAspect;
      return { crop: { x: (naturalWidth - w) / 2, y: 0, width: w, height: naturalHeight }, dest: full };
    }
    const h = naturalWidth / boxAspect;
    return { crop: { x: 0, y: (naturalHeight - h) / 2, width: naturalWidth, height: h }, dest: full };
  }
  // contain
  if (imgAspect > boxAspect) {
    const h = el.width / imgAspect;
    return { crop: whole, dest: { x: 0, y: (el.height - h) / 2, width: el.width, height: h } };
  }
  const w = el.height * imgAspect;
  return { crop: whole, dest: { x: (el.width - w) / 2, y: 0, width: w, height: el.height } };
}

/** The explicit crop equivalent to `cover` (declared asset px) — used when the user enters crop mode. */
export function coverCrop(boxWidth: number, boxHeight: number, naturalWidth: number, naturalHeight: number): CropRect {
  return layoutInAssetSpace({ width: boxWidth, height: boxHeight, crop: null, objectFit: 'cover' }, naturalWidth, naturalHeight).crop;
}

/**
 * Makes a crop valid for an image of `naturalWidth x naturalHeight` (declared px)
 * WITHOUT distorting: the result has aspect `boxAspect` (default: the crop's own),
 * is the largest such rect inside the original crop, shrunk uniformly until it fits
 * the image, and keeps the original center where possible. Use it for the crop UI,
 * "Replace image" (keep framing on a new asset) and box resizes.
 */
export function fitCropToImage(crop: CropRect, naturalWidth: number, naturalHeight: number, boxAspect?: number): CropRect {
  const aspect = boxAspect && boxAspect > 0 ? boxAspect : crop.width > 0 && crop.height > 0 ? crop.width / crop.height : naturalWidth / naturalHeight;
  let w = Math.max(crop.width, 0);
  let h = w / aspect;
  if (h > crop.height && crop.height > 0) {
    h = crop.height;
    w = h * aspect;
  }
  if (!(w > 0 && h > 0)) return coverCrop(aspect, 1, naturalWidth, naturalHeight);
  const k = Math.min(1, naturalWidth / w, naturalHeight / h);
  w *= k;
  h *= k;
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  return {
    x: clamp(cx - w / 2, 0, naturalWidth - w),
    y: clamp(cy - h / 2, 0, naturalHeight - h),
    width: w,
    height: h,
  };
}

/** Decoded-vs-declared check for loaders: an aspect mismatch (> 1 %) means a wrong record (e.g. un-baked EXIF rotation). */
export function compareDecodedSize(declared: Size, decoded: Size): { scaleX: number; scaleY: number; aspectMismatch: boolean } {
  const scaleX = decoded.width / declared.width;
  const scaleY = decoded.height / declared.height;
  return { scaleX, scaleY, aspectMismatch: Math.abs(scaleX / scaleY - 1) > 0.01 };
}

// ---------------------------------------------------------------------------
// Transformer -> document
// ---------------------------------------------------------------------------

/** Node attributes read after a Konva Transformer interaction (node.attrs / decompose()). */
export interface NodeTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX?: number;
  skewY?: number;
}

const EPS = 1e-6;

/**
 * THE rule for committing a Transformer interaction ("bake scale into the element").
 * Returns the new element; the node's scale must then be reset to 1.
 *  - x, y, rotation are taken as-is; width *= |scaleX|, height *= |scaleY|.
 *  - scaleX < 0 && scaleY < 0 equals a 180° rotation with positive scales and is
 *    normalized that way. A single negative scale (mirror) or any skew cannot be
 *    represented and throws RangeError: the editor must use `flipEnabled: false`
 *    and the anchors from transformerConstraints().
 *  - text: a uniform scale (scaleX == scaleY) also multiplies fontSize (letterSpacing
 *    is in em, so tracking follows automatically). A non-uniform scale (side anchor)
 *    changes the box only; text re-wraps, fontSize is unchanged.
 *  - shapes keep strokeWidth/cornerRadius; images keep crop and filters.
 */
export function bakeTransform<E extends PlakatElement>(el: E, t: NodeTransform): E {
  if (Math.abs(t.skewX ?? 0) > EPS || Math.abs(t.skewY ?? 0) > EPS) {
    throw new RangeError('Skew cannot be represented in a Plakat document (see transformerConstraints())');
  }
  let { scaleX, scaleY, rotation } = t;
  if (scaleX < 0 && scaleY < 0) {
    scaleX = -scaleX;
    scaleY = -scaleY;
    rotation += 180;
  } else if (scaleX < 0 || scaleY < 0) {
    throw new RangeError('Mirroring by a negative scale is not supported (use flipEnabled: false)');
  }
  const next = { ...el, x: t.x, y: t.y, rotation, width: el.width * scaleX, height: el.height * scaleY };
  if (next.type === 'text' && Math.abs(scaleX - scaleY) <= EPS * Math.max(1, scaleX)) {
    next.fontSize = Math.min(Math.max(el.type === 'text' ? el.fontSize * scaleX : 1, 0.01), 5_000);
  }
  return next;
}

export type TransformerAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-right'
  | 'middle-left'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

const CORNERS: TransformerAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const ALL_ANCHORS: TransformerAnchor[] = [...CORNERS, 'top-center', 'middle-right', 'middle-left', 'bottom-center'];

/**
 * Transformer settings that keep every interaction representable by bakeTransform():
 *  - several elements (selection or groupId group) where any rotation is not a
 *    multiple of 90°: uniform corner scaling only (a non-uniform scale of a rotated
 *    node inside an axis-aligned box decomposes into skew);
 *  - a single text element: corners (uniform, scales fontSize) + middle-left/right
 *    (width only, re-wrap);
 *  - a single image: uniform corners only (side-cropping is future work);
 *  - otherwise every anchor, free aspect.
 */
export function transformerConstraints(elements: readonly Pick<PlakatElement, 'type' | 'rotation'>[]): {
  keepRatio: boolean;
  enabledAnchors: TransformerAnchor[];
  flipEnabled: false;
} {
  if (elements.length > 1) {
    const rotated = elements.some((e) => Math.abs(normalizeRotation(e.rotation) % 90) > EPS && Math.abs((normalizeRotation(e.rotation) % 90) - 90) > EPS);
    return rotated ? { keepRatio: true, enabledAnchors: CORNERS, flipEnabled: false } : { keepRatio: false, enabledAnchors: ALL_ANCHORS, flipEnabled: false };
  }
  const only = elements[0];
  if (only?.type === 'text') return { keepRatio: true, enabledAnchors: [...CORNERS, 'middle-left', 'middle-right'], flipEnabled: false };
  if (only?.type === 'image') return { keepRatio: true, enabledAnchors: CORNERS, flipEnabled: false };
  return { keepRatio: false, enabledAnchors: ALL_ANCHORS, flipEnabled: false };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
