/**
 * Pure align / distribute math on AABBs (rotated elements use their rotated bounds,
 * like align-to-page in the schema's centerOnPage/moveBoundsTo).
 *
 * A "unit" is what moves as one piece: a single element, or all selected members of
 * one groupId group. Results are per-element translations (dx, dy) in page px.
 */
import { getSelectionBounds, type Box, type Id, type PlakatElement, type Rect } from '@plakat/schema';

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

export interface AlignUnit {
  /** Element ids moved together. */
  ids: Id[];
  boxes: Box[];
  /** Fixed units are used for reference bounds but never moved (e.g. locked). */
  fixed?: boolean;
}

export type Translation = { dx: number; dy: number };

/** Groups elements into units: elements sharing a groupId form one unit, others are alone. Order: first appearance. */
export function toAlignUnits(elements: readonly PlakatElement[], isFixed: (el: PlakatElement) => boolean = (el) => el.locked): AlignUnit[] {
  const units: AlignUnit[] = [];
  const byGroup = new Map<Id, AlignUnit>();
  for (const el of elements) {
    if (el.groupId) {
      const existing = byGroup.get(el.groupId);
      if (existing) {
        existing.ids.push(el.id);
        existing.boxes.push(el);
        existing.fixed = existing.fixed || isFixed(el);
        continue;
      }
      const unit: AlignUnit = { ids: [el.id], boxes: [el], fixed: isFixed(el) };
      byGroup.set(el.groupId, unit);
      units.push(unit);
    } else {
      units.push({ ids: [el.id], boxes: [el], fixed: isFixed(el) });
    }
  }
  return units;
}

function unitBounds(u: AlignUnit): Rect {
  return getSelectionBounds(u.boxes) ?? { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Align: with ONE unit, relative to the page (0, 0, page.width, page.height); with
 * several, relative to the union bounds of all units. Returns translations for every
 * element of every non-fixed unit that actually moves.
 */
export function computeAlign(units: readonly AlignUnit[], edge: AlignEdge, page: { width: number; height: number }): Map<Id, Translation> {
  const out = new Map<Id, Translation>();
  if (units.length === 0) return out;
  const target: Rect =
    units.length === 1 ? { x: 0, y: 0, width: page.width, height: page.height } : getSelectionBounds(units.flatMap((u) => u.boxes))!;
  for (const u of units) {
    if (u.fixed) continue;
    const b = unitBounds(u);
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case 'left':
        dx = target.x - b.x;
        break;
      case 'center':
        dx = target.x + (target.width - b.width) / 2 - b.x;
        break;
      case 'right':
        dx = target.x + target.width - b.width - b.x;
        break;
      case 'top':
        dy = target.y - b.y;
        break;
      case 'middle':
        dy = target.y + (target.height - b.height) / 2 - b.y;
        break;
      case 'bottom':
        dy = target.y + target.height - b.height - b.y;
        break;
    }
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
    for (const id of u.ids) out.set(id, { dx, dy });
  }
  return out;
}

/**
 * Distribute: needs >= 3 units. Units are sorted by their AABB start on the axis
 * (ties: by center, then input order); the first and last stay, the others are placed
 * so that every gap between consecutive AABBs is equal (gaps may be negative when the
 * units overlap). Fixed units in the middle keep their place (their gaps absorb it).
 */
export function computeDistribute(units: readonly AlignUnit[], axis: DistributeAxis): Map<Id, Translation> {
  const out = new Map<Id, Translation>();
  if (units.length < 3) return out;
  const isX = axis === 'horizontal';
  const items = units.map((u, i) => {
    const b = unitBounds(u);
    return { u, i, start: isX ? b.x : b.y, len: isX ? b.width : b.height };
  });
  items.sort((a, b) => a.start - b.start || a.start + a.len / 2 - (b.start + b.len / 2) || a.i - b.i);
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const span = last.start + last.len - first.start;
  const total = items.reduce((s, it) => s + it.len, 0);
  const gap = (span - total) / (items.length - 1);
  let cursor = first.start + first.len + gap;
  for (let k = 1; k < items.length - 1; k++) {
    const it = items[k]!;
    const d = cursor - it.start;
    cursor += it.len + gap;
    if (it.u.fixed || Math.abs(d) < 1e-9) continue;
    for (const id of it.u.ids) out.set(id, isX ? { dx: d, dy: 0 } : { dx: 0, dy: d });
  }
  return out;
}
