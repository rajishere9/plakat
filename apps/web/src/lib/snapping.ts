/**
 * Pure snapping math for drag (computeSnap) and Transformer resize (computeResizeSnap).
 * Everything runs on axis-aligned bounds in PAGE px (schema D-6: snapping operates on
 * AABBs, see getSnapEdges/getElementBounds). Convert a screen threshold to page px
 * with `threshold = SNAP_THRESHOLD_PX / zoom`.
 */
import { getElementBounds, getSnapEdges, type Id, type Page, type Rect } from '@plakat/schema';

export type { Rect };

/** Screen-space snap distance; divide by zoom before passing as `threshold`. */
export const SNAP_THRESHOLD_PX = 6;

export type GuideKind = 'page-edge' | 'page-center' | 'element-edge' | 'element-center';

/**
 * A snap line in page px. `axis: 'x'` = a VERTICAL line at x = position spanning
 * y = start..end; `axis: 'y'` = a HORIZONTAL line at y = position spanning x = start..end.
 */
export interface Guide {
  axis: 'x' | 'y';
  position: number;
  start: number;
  end: number;
  kind: GuideKind;
}

/** One measured gap of an equal-spacing hint, drawn along the axis at cross position `at`. */
export interface SpacingSegment {
  from: number;
  to: number;
  at: number;
}

/** Equal-spacing hint: every segment has length `gap` (axis 'x' = horizontal gaps). */
export interface SpacingGuide {
  axis: 'x' | 'y';
  gap: number;
  segments: SpacingSegment[];
}

export interface SnapCandidates {
  pageSize: { width: number; height: number };
  /** AABBs of the other (non-moving, visible) elements on the page. */
  others: readonly Rect[];
}

export interface SnapOptions {
  /** Snap to page edges and center (default true). */
  page?: boolean;
  /** Snap to other elements' edges and centers (default true). */
  elements?: boolean;
  /** Equal-spacing snapping between row/column neighbours (default true). */
  equalSpacing?: boolean;
  /** Enable per axis (default both). */
  x?: boolean;
  y?: boolean;
}

export interface SnapResult {
  /** Offset to add to the moving rect (page px). 0 when nothing snapped on that axis. */
  dx: number;
  dy: number;
  guides: Guide[];
  spacing: SpacingGuide[];
}

const EPS = 1e-6;

type Axis = 'x' | 'y';

interface Line {
  value: number;
  kind: GuideKind;
  /** Lower = preferred on |delta| ties. */
  priority: number;
  /** Cross-axis extent of the source (page or element). */
  crossStart: number;
  crossEnd: number;
}

const PRIORITY: Record<GuideKind, number> = { 'page-center': 0, 'page-edge': 1, 'element-center': 2, 'element-edge': 3 };

function pos(r: Rect, axis: Axis): number {
  return axis === 'x' ? r.x : r.y;
}
function size(r: Rect, axis: Axis): number {
  return axis === 'x' ? r.width : r.height;
}
function cross(axis: Axis): Axis {
  return axis === 'x' ? 'y' : 'x';
}

function edgesOf(r: Rect, axis: Axis): [number, number, number] {
  const e = getSnapEdges(r);
  return axis === 'x' ? e.x : e.y;
}

function collectLines(axis: Axis, c: SnapCandidates, opts: SnapOptions): Line[] {
  const lines: Line[] = [];
  if (opts.page !== false) {
    const len = axis === 'x' ? c.pageSize.width : c.pageSize.height;
    const crossLen = axis === 'x' ? c.pageSize.height : c.pageSize.width;
    for (const [value, kind] of [
      [0, 'page-edge'],
      [len / 2, 'page-center'],
      [len, 'page-edge'],
    ] as const) {
      lines.push({ value, kind, priority: PRIORITY[kind], crossStart: 0, crossEnd: crossLen });
    }
  }
  if (opts.elements !== false) {
    const ca = cross(axis);
    for (const o of c.others) {
      const [a, m, b] = edgesOf(o, axis);
      const crossStart = pos(o, ca);
      const crossEnd = crossStart + size(o, ca);
      lines.push({ value: a, kind: 'element-edge', priority: PRIORITY['element-edge'], crossStart, crossEnd });
      lines.push({ value: m, kind: 'element-center', priority: PRIORITY['element-center'], crossStart, crossEnd });
      lines.push({ value: b, kind: 'element-edge', priority: PRIORITY['element-edge'], crossStart, crossEnd });
    }
  }
  return lines;
}

interface AxisSnap {
  delta: number;
  priority: number;
}

/** Best delta (smallest |delta| <= threshold; ties -> lower priority, then first seen). */
function bestLineDelta(moving: readonly number[], lines: readonly Line[], threshold: number): AxisSnap | null {
  let best: AxisSnap | null = null;
  for (const line of lines) {
    for (const edge of moving) {
      const delta = line.value - edge;
      const ad = Math.abs(delta);
      if (ad > threshold + EPS) continue;
      if (!best) {
        best = { delta, priority: line.priority };
        continue;
      }
      const bd = Math.abs(best.delta);
      if (ad < bd - EPS || (Math.abs(ad - bd) <= EPS && line.priority < best.priority)) {
        best = { delta, priority: line.priority };
      }
    }
  }
  return best;
}

function guidesFor(axis: Axis, moved: Rect, lines: readonly Line[]): Guide[] {
  const ca = cross(axis);
  const movingEdges = edgesOf(moved, axis);
  const mStart = pos(moved, ca);
  const mEnd = mStart + size(moved, ca);
  const out: Guide[] = [];
  for (const line of lines) {
    if (!movingEdges.some((e) => Math.abs(e - line.value) <= 1e-4)) continue;
    const isPage = line.kind === 'page-edge' || line.kind === 'page-center';
    const start = isPage ? line.crossStart : Math.min(mStart, line.crossStart);
    const end = isPage ? line.crossEnd : Math.max(mEnd, line.crossEnd);
    const existing = out.find((g) => Math.abs(g.position - line.value) <= 1e-4);
    if (existing) {
      existing.start = Math.min(existing.start, start);
      existing.end = Math.max(existing.end, end);
      if (PRIORITY[line.kind] < PRIORITY[existing.kind]) existing.kind = line.kind;
    } else {
      out.push({ axis, position: line.value, start, end, kind: line.kind });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Equal spacing
// ---------------------------------------------------------------------------

interface SpacingCandidate {
  delta: number;
  guide: SpacingGuide;
}

function overlapsCross(a: Rect, b: Rect, axis: Axis): boolean {
  const ca = cross(axis);
  return pos(a, ca) < pos(b, ca) + size(b, ca) - EPS && pos(b, ca) < pos(a, ca) + size(a, ca) - EPS;
}

function crossMid(a: Rect, b: Rect, axis: Axis): number {
  const ca = cross(axis);
  const s = Math.max(pos(a, ca), pos(b, ca));
  const e = Math.min(pos(a, ca) + size(a, ca), pos(b, ca) + size(b, ca));
  return (s + e) / 2;
}

function spacingCandidates(axis: Axis, m: Rect, others: readonly Rect[]): SpacingCandidate[] {
  const row = others.filter((o) => overlapsCross(o, m, axis));
  const mStart = pos(m, axis);
  const mSize = size(m, axis);
  const mEnd = mStart + mSize;
  const mCenter = mStart + mSize / 2;
  const end = (r: Rect) => pos(r, axis) + size(r, axis);
  const center = (r: Rect) => pos(r, axis) + size(r, axis) / 2;

  const before = row.filter((o) => center(o) < mCenter && end(o) <= mEnd).sort((a, b) => end(b) - end(a));
  const after = row.filter((o) => center(o) > mCenter && pos(o, axis) >= mStart).sort((a, b) => pos(a, axis) - pos(b, axis));
  const out: SpacingCandidate[] = [];

  const L = before[0];
  const R = after[0];
  // 1. Centered between the nearest neighbours.
  if (L && R) {
    const room = pos(R, axis) - end(L);
    if (room >= mSize - EPS) {
      const target = (end(L) + pos(R, axis) - mSize) / 2;
      const gap = (room - mSize) / 2;
      out.push({
        delta: target - mStart,
        guide: {
          axis,
          gap,
          segments: [
            { from: end(L), to: target, at: crossMid(L, m, axis) },
            { from: target + mSize, to: pos(R, axis), at: crossMid(R, m, axis) },
          ],
        },
      });
    }
  }
  // 2. Continue the gap of the two nearest neighbours before.
  if (L) {
    const A = row.filter((o) => o !== L && end(o) <= pos(L, axis) + EPS).sort((a, b) => end(b) - end(a))[0];
    if (A) {
      const gap = pos(L, axis) - end(A);
      const target = end(L) + gap;
      out.push({
        delta: target - mStart,
        guide: {
          axis,
          gap,
          segments: [
            { from: end(A), to: pos(L, axis), at: crossMid(A, L, axis) },
            { from: end(L), to: target, at: crossMid(L, m, axis) },
          ],
        },
      });
    }
  }
  // 3. Continue the gap of the two nearest neighbours after.
  if (R) {
    const C = row.filter((o) => o !== R && pos(o, axis) >= end(R) - EPS).sort((a, b) => pos(a, axis) - pos(b, axis))[0];
    if (C) {
      const gap = pos(C, axis) - end(R);
      const target = pos(R, axis) - gap - mSize;
      out.push({
        delta: target - mStart,
        guide: {
          axis,
          gap,
          segments: [
            { from: target + mSize, to: pos(R, axis), at: crossMid(R, m, axis) },
            { from: end(R), to: pos(C, axis), at: crossMid(R, C, axis) },
          ],
        },
      });
    }
  }
  return out.filter((c) => c.guide.gap >= -EPS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snaps a dragged selection. `moving` is the AABB of the dragged selection at its
 * current (unsnapped) position; returns the offset to apply and the guides to draw.
 * Rules: on each axis independently, every edge/center of `moving` is compared with
 * the page edges/center and every other rect's edges/center; the smallest |delta|
 * within `threshold` wins (ties: page center > page edge > element center > element
 * edge, then input order). Equal-spacing candidates win only when strictly closer.
 * All lines that coincide after snapping are returned as guides (merged per position).
 */
export function computeSnap(moving: Rect, candidates: SnapCandidates, threshold: number, opts: SnapOptions = {}): SnapResult {
  const result: SnapResult = { dx: 0, dy: 0, guides: [], spacing: [] };
  for (const axis of ['x', 'y'] as const) {
    if (opts[axis] === false) continue;
    const lines = collectLines(axis, candidates, opts);
    const best = bestLineDelta(edgesOf(moving, axis), lines, threshold);
    let delta = best?.delta ?? 0;
    let spacing: SpacingGuide[] = [];
    if (opts.equalSpacing !== false && opts.elements !== false) {
      const cands = spacingCandidates(axis, moving, candidates.others).filter((c) => Math.abs(c.delta) <= threshold + EPS);
      cands.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      const sp = cands[0];
      if (sp && (!best || Math.abs(sp.delta) < Math.abs(best.delta) - EPS)) {
        delta = sp.delta;
        spacing = cands.filter((c) => Math.abs(c.delta - sp.delta) <= 1e-4).map((c) => c.guide);
      } else if (best) {
        spacing = cands.filter((c) => Math.abs(c.delta - best.delta) <= 1e-4).map((c) => c.guide);
      }
    }
    const snapped = best || spacing.length > 0;
    if (!snapped) continue;
    const moved: Rect = axis === 'x' ? { ...moving, x: moving.x + delta } : { ...moving, y: moving.y + delta };
    if (axis === 'x') result.dx = delta;
    else result.dy = delta;
    result.guides.push(...guidesFor(axis, moved, lines));
    result.spacing.push(...spacing);
  }
  return result;
}

/** Which edges of the box a Transformer anchor moves. */
export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/** Edges moved by a Konva Transformer anchor name (e.g. 'top-left'). */
export function edgesForAnchor(anchor: string): ResizeEdges {
  return {
    left: anchor.endsWith('left'),
    right: anchor.endsWith('right'),
    top: anchor.startsWith('top'),
    bottom: anchor.startsWith('bottom'),
  };
}

export interface ResizeSnapResult {
  rect: Rect;
  guides: Guide[];
}

/**
 * Snaps the moving edges of a box being resized (unrotated boxes; use it from the
 * Transformer's boundBoxFunc after converting to page px). Each moving edge snaps to
 * the nearest page/element line within `threshold`. With `keepRatio`, only the edge
 * with the smallest snap distance is snapped and the other dimension follows the
 * original aspect, anchored at the opposite edge/corner.
 */
export function computeResizeSnap(
  rect: Rect,
  edges: ResizeEdges,
  candidates: SnapCandidates,
  threshold: number,
  opts: SnapOptions & { keepRatio?: boolean; minSize?: number } = {},
): ResizeSnapResult {
  const minSize = opts.minSize ?? 1;
  const out: Rect = { ...rect };
  type EdgeSnap = { axis: Axis; side: 'start' | 'end'; delta: number };
  const snaps: EdgeSnap[] = [];
  for (const axis of ['x', 'y'] as const) {
    if (opts[axis] === false) continue;
    const lines = collectLines(axis, candidates, opts);
    const startMoving = axis === 'x' ? edges.left : edges.top;
    const endMoving = axis === 'x' ? edges.right : edges.bottom;
    const start = pos(rect, axis);
    const end = start + size(rect, axis);
    if (startMoving) {
      const b = bestLineDelta([start], lines, threshold);
      if (b) snaps.push({ axis, side: 'start', delta: b.delta });
    }
    if (endMoving) {
      const b = bestLineDelta([end], lines, threshold);
      if (b) snaps.push({ axis, side: 'end', delta: b.delta });
    }
  }
  const apply = (s: EdgeSnap) => {
    if (s.axis === 'x') {
      if (s.side === 'start') {
        const w = out.width - s.delta;
        if (w >= minSize) {
          out.x += s.delta;
          out.width = w;
        }
      } else if (out.width + s.delta >= minSize) out.width += s.delta;
    } else if (s.side === 'start') {
      const h = out.height - s.delta;
      if (h >= minSize) {
        out.y += s.delta;
        out.height = h;
      }
    } else if (out.height + s.delta >= minSize) out.height += s.delta;
  };
  if (opts.keepRatio && snaps.length > 0 && rect.width > 0 && rect.height > 0) {
    const s = [...snaps].sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0]!;
    const ratio = rect.width / rect.height;
    apply(s);
    if (s.axis === 'x') {
      const h = out.width / ratio;
      if (edges.top && !edges.bottom) out.y = rect.y + rect.height - h;
      else if (!edges.top && !edges.bottom) out.y = rect.y + (rect.height - h) / 2;
      out.height = h;
    } else {
      const w = out.height * ratio;
      if (edges.left && !edges.right) out.x = rect.x + rect.width - w;
      else if (!edges.left && !edges.right) out.x = rect.x + (rect.width - w) / 2;
      out.width = w;
    }
  } else {
    for (const s of snaps) apply(s);
  }
  const guides: Guide[] = [];
  for (const axis of ['x', 'y'] as const) {
    if (opts[axis] === false) continue;
    const lines = collectLines(axis, candidates, opts);
    const startMoving = axis === 'x' ? edges.left : edges.top;
    const endMoving = axis === 'x' ? edges.right : edges.bottom;
    const relevant: number[] = [];
    if (startMoving) relevant.push(pos(out, axis));
    if (endMoving) relevant.push(pos(out, axis) + size(out, axis));
    const all = guidesFor(axis, out, lines);
    guides.push(...all.filter((g) => relevant.some((v) => Math.abs(v - g.position) <= 1e-4)));
  }
  return { rect: out, guides };
}

/**
 * AABBs of the visible elements of `page`, excluding `excludeIds` (the moving ones):
 * the `others` input of computeSnap/computeResizeSnap.
 */
export function getSnapTargets(page: Pick<Page, 'elements'>, excludeIds: Iterable<Id>): Rect[] {
  const exclude = new Set(excludeIds);
  return page.elements.filter((e) => !e.hidden && !exclude.has(e.id)).map((e) => getElementBounds(e));
}
