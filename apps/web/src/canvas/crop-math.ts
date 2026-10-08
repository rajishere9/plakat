/**
 * Crop mode geometry (pure). Everything is in the image element's DISPLAYED local space
 * (origin = element top-left, unrotated, flips applied, page px):
 *
 *  - `ghost`: where the WHOLE image lies when the element's current crop fills the box
 *    (fixed for the session, scale `k` = box px per declared asset px). A contain/fill
 *    image starts from the largest centered crop with the box aspect;
 *  - `rect`:  the crop rect the user drags/resizes; starts as the box (0, 0, w, h), always
 *    has the box aspect ratio (the box size is kept, so a different aspect would distort)
 *    and always lies inside `ghost`.
 *
 * On commit, `cropFromRect` maps the rect back to declared asset px (schema D-19).
 */
import { fitCropToImage, type CropRect, type ImageAsset, type ImageElement, type Rect } from '@plakat/schema';
import { initialCrop } from '../lib/crop.ts';

export interface CropSession {
  /** Box px per declared asset px. */
  k: number;
  /** Whole image, displayed local px. */
  ghost: Rect;
  /** Initial crop rect (= the box). */
  rect: Rect;
  /** Box aspect (width / height). */
  aspect: number;
  flipX: boolean;
  flipY: boolean;
}

type CropElement = Pick<ImageElement, 'width' | 'height' | 'crop' | 'objectFit' | 'flipX' | 'flipY'>;

export function beginCropSession(el: CropElement, asset: Pick<ImageAsset, 'width' | 'height'>): CropSession {
  const aspect = el.width > 0 && el.height > 0 ? el.width / el.height : 1;
  // Start from a crop with the BOX aspect (contain/fill images start from the whole image,
  // which would otherwise distort the box): the largest such rect, centered.
  const c = fitCropToImage(initialCrop(el, asset), asset.width, asset.height, aspect);
  const k = c.width > 0 ? el.width / c.width : 1;
  const ky = c.height > 0 ? el.height / c.height : k;
  // k ≈ ky by construction; use their mean against float noise.
  const kk = Number.isFinite(ky) && ky > 0 ? (k + ky) / 2 : k;
  const g = { x: -c.x * kk, y: -c.y * kk, width: asset.width * kk, height: asset.height * kk };
  const ghost: Rect = {
    x: el.flipX ? el.width - (g.x + g.width) : g.x,
    y: el.flipY ? el.height - (g.y + g.height) : g.y,
    width: g.width,
    height: g.height,
  };
  return {
    k: kk,
    ghost,
    rect: { x: 0, y: 0, width: el.width, height: el.height },
    aspect,
    flipX: el.flipX,
    flipY: el.flipY,
  };
}

function clamp(v: number, min: number, max: number): number {
  return max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v));
}

/** Keeps a dragged crop rect (size unchanged) inside the ghost image. */
export function constrainCropDrag(rect: Rect, ghost: Rect): Rect {
  const width = Math.min(rect.width, ghost.width);
  const height = Math.min(rect.height, ghost.height);
  return {
    x: clamp(rect.x, ghost.x, ghost.x + ghost.width - width),
    y: clamp(rect.y, ghost.y, ghost.y + ghost.height - height),
    width,
    height,
  };
}

export type CropAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * Constrains a resized crop rect: keeps `aspect`, keeps the corner opposite to `anchor`
 * fixed (from `prev`), never smaller than `minWidth`, and never outside `ghost` (the rect
 * is shrunk uniformly about the fixed corner until it fits).
 */
export function constrainCropResize(proposed: Rect, prev: Rect, ghost: Rect, aspect: number, anchor: CropAnchor, minWidth = 4): Rect {
  const left = anchor.endsWith('left');
  const top = anchor.startsWith('top');
  // Fixed corner (opposite to the dragged anchor).
  const fx = left ? prev.x + prev.width : prev.x;
  const fy = top ? prev.y + prev.height : prev.y;
  // Desired size: the larger of the two proposed extents, projected on the aspect.
  let w = Math.max(proposed.width, proposed.height * aspect);
  const minW = Math.max(minWidth, minWidth * aspect);
  w = Math.max(w, minW);
  // Room available inside the ghost from the fixed corner towards the anchor.
  const roomX = left ? fx - ghost.x : ghost.x + ghost.width - fx;
  const roomY = top ? fy - ghost.y : ghost.y + ghost.height - fy;
  w = Math.min(w, roomX, roomY * aspect);
  w = Math.max(w, 0);
  const h = w / aspect;
  return { x: left ? fx - w : fx, y: top ? fy - h : fy, width: w, height: h };
}

/** Maps the crop rect (displayed local px) to a crop in declared asset px. */
export function cropFromRect(rect: Rect, session: Pick<CropSession, 'ghost' | 'k' | 'flipX' | 'flipY'>): CropRect {
  const { ghost, k } = session;
  const x = session.flipX ? ghost.x + ghost.width - (rect.x + rect.width) : rect.x - ghost.x;
  const y = session.flipY ? ghost.y + ghost.height - (rect.y + rect.height) : rect.y - ghost.y;
  return { x: x / k, y: y / k, width: rect.width / k, height: rect.height / k };
}

/** True when the rect differs from the session's starting rect (beyond float noise). */
export function cropRectChanged(rect: Rect, initial: Rect, eps = 1e-6): boolean {
  return (
    Math.abs(rect.x - initial.x) > eps ||
    Math.abs(rect.y - initial.y) > eps ||
    Math.abs(rect.width - initial.width) > eps ||
    Math.abs(rect.height - initial.height) > eps
  );
}
