/**
 * Pure view math for the workspace (render-export-pipeline.md P-12): zoom and pan live on
 * the stage, page offsets on the page frames.
 *
 * Coordinate spaces:
 *  - screen: CSS px relative to the workspace container's top-left corner
 *  - world:  stage-local units (before stage scale). screen = world × zoom + pan
 *  - page:   document px of one page. world = page + frame offset (PageFrame.x/y)
 */
import type { Id, PageSize, Rect } from '@plakat/schema';

export interface Point {
  x: number;
  y: number;
}

/** Stage transform: `stage.scale() = zoom`, `stage.position() = (panX, panY)`. */
export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** One page frame in world units. */
export interface PageFrameLayout {
  pageId: Id;
  index: number;
  /** World offset of the page origin (the page frame's x/y). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageLayout {
  pages: PageFrameLayout[];
  /** Union of all page boxes (world units). */
  bounds: Rect;
  /** World distance between the tops of consecutive pages. */
  stride: number;
}

/** Screen px between stacked pages (room for the page labels). */
export const PAGE_GAP_PX = 56;
/** Screen px kept around the content when panning is clamped. */
export const PAN_PADDING_PX = 48;

/**
 * Pages stacked vertically at x = 0. The gap is constant in SCREEN px, and the stride is
 * rounded up to whole device pixels so every page origin lands on an integer device pixel
 * when the pan is (render-export-pipeline.md §7, devicePixelRatio row).
 */
export function computePageLayout(
  pageIds: readonly Id[],
  size: Pick<PageSize, 'width' | 'height'>,
  zoom: number,
  devicePixelRatio = 1,
  gapPx = PAGE_GAP_PX,
): PageLayout {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const strideScreen = Math.ceil((size.height * zoom + gapPx) * dpr - 1e-6) / dpr;
  const stride = strideScreen / zoom;
  const pages = pageIds.map((pageId, index) => ({ pageId, index, x: 0, y: index * stride, width: size.width, height: size.height }));
  const height = pages.length === 0 ? 0 : (pages.length - 1) * stride + size.height;
  return { pages, bounds: { x: 0, y: 0, width: size.width, height }, stride };
}

export function screenToWorld(view: ViewState, p: Point): Point {
  return { x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom };
}

export function worldToScreen(view: ViewState, p: Point): Point {
  return { x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY };
}

export function screenToPage(view: ViewState, frame: Pick<PageFrameLayout, 'x' | 'y'>, p: Point): Point {
  const w = screenToWorld(view, p);
  return { x: w.x - frame.x, y: w.y - frame.y };
}

export function pageToScreen(view: ViewState, frame: Pick<PageFrameLayout, 'x' | 'y'>, p: Point): Point {
  return worldToScreen(view, { x: p.x + frame.x, y: p.y + frame.y });
}

/** Converts a page-space rect to a screen-space rect (axis-aligned; no rotation). */
export function pageRectToScreen(view: ViewState, frame: Pick<PageFrameLayout, 'x' | 'y'>, r: Rect): Rect {
  const p = pageToScreen(view, frame, r);
  return { x: p.x, y: p.y, width: r.width * view.zoom, height: r.height * view.zoom };
}

export function screenRectToPage(view: ViewState, frame: Pick<PageFrameLayout, 'x' | 'y'>, r: Rect): Rect {
  const p = screenToPage(view, frame, r);
  return { x: p.x, y: p.y, width: r.width / view.zoom, height: r.height / view.zoom };
}

/** Page frame containing the world point, or null. */
export function pageAtWorldPoint(layout: PageLayout, p: Point): PageFrameLayout | null {
  return layout.pages.find((f) => p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y && p.y <= f.y + f.height) ?? null;
}

/** Page frame nearest to the world point (vertical distance; inside counts as 0). */
export function nearestPage(layout: PageLayout, p: Point): PageFrameLayout | null {
  let best: PageFrameLayout | null = null;
  let bestD = Infinity;
  for (const f of layout.pages) {
    const d = p.y < f.y ? f.y - p.y : p.y > f.y + f.height ? p.y - (f.y + f.height) : 0;
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/**
 * New view for `newZoom` that keeps the page point under `anchor` (screen) fixed. The layout
 * depends on zoom (screen-constant gaps), so the anchor is expressed relative to the nearest
 * page and re-resolved in the new layout.
 */
export function zoomAround(
  view: ViewState,
  layoutAt: (zoom: number) => PageLayout,
  anchor: Point,
  newZoom: number,
): ViewState {
  const before = layoutAt(view.zoom);
  const world = screenToWorld(view, anchor);
  const ref = nearestPage(before, world);
  if (!ref) {
    return { zoom: newZoom, panX: anchor.x - world.x * newZoom, panY: anchor.y - world.y * newZoom };
  }
  const local = { x: world.x - ref.x, y: world.y - ref.y };
  const after = layoutAt(newZoom).pages[ref.index] ?? ref;
  return {
    zoom: newZoom,
    panX: anchor.x - (after.x + local.x) * newZoom,
    panY: anchor.y - (after.y + local.y) * newZoom,
  };
}

/**
 * Keeps the content reachable: an axis whose content fits the viewport (with `padding` on
 * both sides) is centered; otherwise the viewport center must stay over the content, so
 * scrolling stops with the content edge at the middle of the viewport.
 */
export function clampPan(view: ViewState, content: Rect, viewport: Viewport, padding = PAN_PADDING_PX): ViewState {
  const axis = (pan: number, start: number, length: number, vp: number) => {
    const s = length * view.zoom;
    if (s + padding * 2 <= vp) return (vp - s) / 2 - start * view.zoom;
    const min = vp / 2 - (start + length) * view.zoom; // content end >= viewport center
    const max = vp / 2 - start * view.zoom; // content start <= viewport center
    return Math.min(max, Math.max(min, pan));
  };
  return {
    zoom: view.zoom,
    panX: axis(view.panX, content.x, content.width, viewport.width),
    panY: axis(view.panY, content.y, content.height, viewport.height),
  };
}

/** Rounds the pan to whole device pixels (page origins then land on device pixels). */
export function roundPan(view: ViewState, devicePixelRatio = 1): ViewState {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { zoom: view.zoom, panX: Math.round(view.panX * dpr) / dpr, panY: Math.round(view.panY * dpr) / dpr };
}

/**
 * Pan that shows `frame` in the viewport: centered when it fits, else its top-left at the
 * padding.
 */
export function panToShowPage(frame: PageFrameLayout, zoom: number, viewport: Viewport, padding = PAN_PADDING_PX): { panX: number; panY: number } {
  const w = frame.width * zoom;
  const h = frame.height * zoom;
  const panX = w + padding * 2 <= viewport.width ? (viewport.width - w) / 2 - frame.x * zoom : padding - frame.x * zoom;
  const panY = h + padding * 2 <= viewport.height ? (viewport.height - h) / 2 - frame.y * zoom : padding - frame.y * zoom;
  return { panX, panY };
}

/** Visible fraction (0..1) of a page's screen box inside the viewport. */
export function pageVisibility(view: ViewState, frame: PageFrameLayout, viewport: Viewport): number {
  const r = pageRectToScreen(view, frame, { x: 0, y: 0, width: frame.width, height: frame.height });
  const w = Math.max(0, Math.min(r.x + r.width, viewport.width) - Math.max(r.x, 0));
  const h = Math.max(0, Math.min(r.y + r.height, viewport.height) - Math.max(r.y, 0));
  const area = r.width * r.height;
  return area > 0 ? (w * h) / area : 0;
}

/** The page that dominates the viewport: the one containing (or nearest to) the viewport center. */
export function pageAtViewportCenter(view: ViewState, layout: PageLayout, viewport: Viewport): PageFrameLayout | null {
  return nearestPage(layout, screenToWorld(view, { x: viewport.width / 2, y: viewport.height / 2 }));
}

/** Snap threshold in page px for the screen threshold (lib/snapping: SNAP_THRESHOLD_PX / zoom). */
export function snapThresholdForZoom(zoom: number, screenPx = 6): number {
  return screenPx / (zoom > 0 ? zoom : 1);
}

/** Wheel delta in CSS px (deltaMode 1 = lines, 2 = pages). */
export function wheelDeltaPx(delta: number, deltaMode: number, pageSize = 800): number {
  return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * pageSize : delta;
}

/**
 * Zoom factor for a Mod+wheel / trackpad pinch event (pinch arrives as ctrl+wheel with
 * small deltas; a mouse wheel notch is ~100 px). Clamped per event.
 */
export function wheelZoomFactor(deltaYPx: number): number {
  const d = Math.max(-60, Math.min(60, deltaYPx));
  return Math.exp(-d * 0.006);
}

/** Normalized rect from two corner points. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}
