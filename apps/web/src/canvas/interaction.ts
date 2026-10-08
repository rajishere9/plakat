/** Pure helpers for pointer interactions (marquee, rotation snapping, transform commits). */
import { getElementBounds, getSelectionBounds, type Id, type NodeTransform, type Page, type PlakatElement, type Rect } from '@plakat/schema';
import { rectsIntersect } from './viewport.ts';

/** Pointer travel (screen px) before a press becomes a drag / marquee. */
export const DRAG_THRESHOLD_PX = 3;

/** Rotation step while Shift is held. */
export const ROTATION_STEP_DEG = 15;

/**
 * Konva Transformer rotation snapping: with Shift every 15° (tolerance = half a step, so the
 * angle is always snapped); otherwise a light magnet at the right angles.
 */
export function rotationSnapConfig(shift: boolean): { rotationSnaps: number[]; rotationSnapTolerance: number } {
  if (shift) {
    const snaps: number[] = [];
    for (let a = 0; a < 360; a += ROTATION_STEP_DEG) snaps.push(a);
    return { rotationSnaps: snaps, rotationSnapTolerance: ROTATION_STEP_DEG / 2 };
  }
  return { rotationSnaps: [0, 90, 180, 270], rotationSnapTolerance: 3 };
}

/** Snaps an angle (deg) to the nearest multiple of `step`, normalized to [0, 360). */
export function snapAngle(deg: number, step = ROTATION_STEP_DEG): number {
  const r = Math.round(deg / step) * step;
  const n = ((r % 360) + 360) % 360;
  return Object.is(n, -0) ? 0 : n;
}

/**
 * Ids whose (rotated) AABB intersects the marquee rect (page px). Hidden and locked elements
 * are skipped; `groupId` siblings are expanded by the store's select().
 */
export function elementsInMarquee(page: Pick<Page, 'elements'>, marquee: Rect, opts: { includeLocked?: boolean } = {}): Id[] {
  if (marquee.width <= 0 && marquee.height <= 0) return [];
  return page.elements
    .filter((e) => !e.hidden && (opts.includeLocked || !e.locked) && rectsIntersect(getElementBounds(e), marquee))
    .map((e) => e.id);
}

/** Union AABB (page px) of elements shifted by (dx, dy); null when empty. */
export function movedSelectionBounds(elements: readonly PlakatElement[], dx = 0, dy = 0): Rect | null {
  const b = getSelectionBounds(elements);
  return b ? { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height } : null;
}

/**
 * Cleans a node transform read after a Transformer interaction before `commitTransforms`:
 *  - `x`, `y`, `scaleX`, `scaleY` are the node's own (page-space) attributes;
 *  - the rotation comes from the FRAME-relative matrix (what the user saw and snapped on
 *    screen): the content group's contentScaleX/Y may differ by up to 0.5 / W (P-8), which
 *    turns a rotated node's local attributes into a slightly different angle plus a tiny
 *    skew that bakeTransform would reject;
 *  - residual skew is dropped; a rotate-only gesture keeps scale exactly 1 (no size creep).
 */
export function cleanNodeTransform(
  local: { x: number; y: number; scaleX: number; scaleY: number },
  frameRotation: number,
  opts: { rotateOnly?: boolean } = {},
): NodeTransform {
  const scaleX = opts.rotateOnly ? 1 : local.scaleX;
  const scaleY = opts.rotateOnly ? 1 : local.scaleY;
  return { x: local.x, y: local.y, rotation: frameRotation, scaleX, scaleY, skewX: 0, skewY: 0 };
}

/** True when a pointer moved further than the drag threshold. */
export function pastThreshold(a: { x: number; y: number }, b: { x: number; y: number }, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) > threshold;
}
