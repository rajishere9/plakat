import { describe, expect, it } from 'vitest';
import {
  clampPan,
  computePageLayout,
  nearestPage,
  pageAtViewportCenter,
  pageAtWorldPoint,
  pageRectToScreen,
  pageToScreen,
  pageVisibility,
  panToShowPage,
  rectFromPoints,
  rectsIntersect,
  roundPan,
  screenRectToPage,
  screenToPage,
  screenToWorld,
  snapThresholdForZoom,
  wheelDeltaPx,
  wheelZoomFactor,
  worldToScreen,
  zoomAround,
  type ViewState,
} from './viewport.ts';

const A4 = { width: 793.7007874015749, height: 1122.5196850393702 };

describe('computePageLayout', () => {
  it('stacks pages vertically with a screen-constant gap', () => {
    const l = computePageLayout(['a', 'b', 'c'], { width: 1080, height: 1080 }, 0.5, 1, 56);
    expect(l.pages.map((p) => p.y)).toEqual([0, (540 + 56) / 0.5, (2 * (540 + 56)) / 0.5]);
    expect(l.pages.every((p) => p.x === 0 && p.width === 1080 && p.height === 1080)).toBe(true);
    expect(l.bounds).toEqual({ x: 0, y: 0, width: 1080, height: 2 * l.stride + 1080 });
    // screen gap between page 1 bottom and page 2 top
    expect((l.pages[1]!.y - 1080) * 0.5).toBeCloseTo(56, 9);
  });

  it('rounds the stride up to whole device pixels so every page origin is pixel-aligned', () => {
    for (const [zoom, dpr] of [
      [0.37, 1],
      [0.37, 2],
      [0.6180339, 1.5],
      [1.25, 3],
    ] as const) {
      const l = computePageLayout(['a', 'b', 'c', 'd'], A4, zoom, dpr);
      for (const p of l.pages) {
        const devicePx = p.y * zoom * dpr;
        expect(Math.abs(devicePx - Math.round(devicePx))).toBeLessThan(1e-6);
      }
      expect(l.stride * zoom).toBeGreaterThanOrEqual(A4.height * zoom + 56 - 1e-9);
    }
  });

  it('handles an empty page list', () => {
    expect(computePageLayout([], A4, 1).bounds.height).toBe(0);
  });
});

describe('coordinate transforms', () => {
  const view: ViewState = { zoom: 0.37, panX: 123.5, panY: -40 };
  const frame = { x: 0, y: 1500 };

  it('screen ↔ world ↔ page round-trip', () => {
    const s = { x: 400.25, y: 333 };
    const w = screenToWorld(view, s);
    expect(worldToScreen(view, w).x).toBeCloseTo(s.x, 9);
    expect(worldToScreen(view, w).y).toBeCloseTo(s.y, 9);
    const p = screenToPage(view, frame, s);
    expect(p.x).toBeCloseTo((400.25 - 123.5) / 0.37, 9);
    expect(p.y).toBeCloseTo((333 + 40) / 0.37 - 1500, 9);
    const back = pageToScreen(view, frame, p);
    expect(back.x).toBeCloseTo(s.x, 9);
    expect(back.y).toBeCloseTo(s.y, 9);
  });

  it('page rect ↔ screen rect', () => {
    const r = { x: 10, y: 20, width: 100, height: 50 };
    const sr = pageRectToScreen(view, frame, r);
    expect(sr.width).toBeCloseTo(37, 9);
    expect(sr.height).toBeCloseTo(18.5, 9);
    const back = screenRectToPage(view, frame, sr);
    expect(back.x).toBeCloseTo(10, 9);
    expect(back.y).toBeCloseTo(20, 9);
    expect(back.width).toBeCloseTo(100, 9);
  });

  it('finds the page under / nearest to a world point', () => {
    const l = computePageLayout(['a', 'b'], { width: 100, height: 100 }, 1, 1, 50);
    expect(pageAtWorldPoint(l, { x: 50, y: 50 })?.pageId).toBe('a');
    expect(pageAtWorldPoint(l, { x: 50, y: 120 })).toBeNull();
    expect(pageAtWorldPoint(l, { x: 50, y: 160 })?.pageId).toBe('b');
    expect(nearestPage(l, { x: 50, y: 110 })?.pageId).toBe('a');
    expect(nearestPage(l, { x: 50, y: 145 })?.pageId).toBe('b');
    expect(nearestPage(l, { x: 50, y: 5000 })?.pageId).toBe('b');
  });
});

describe('zoomAround', () => {
  it('keeps the page point under the anchor fixed (layout depends on zoom)', () => {
    const ids = ['a', 'b', 'c'];
    const layoutAt = (z: number) => computePageLayout(ids, A4, z, 2);
    const view: ViewState = { zoom: 0.4, panX: 50, panY: -300 };
    const anchor = { x: 300, y: 420 };
    const before = layoutAt(0.4);
    const world = screenToWorld(view, anchor);
    const page = nearestPage(before, world)!;
    const local = { x: world.x - page.x, y: world.y - page.y };
    const next = zoomAround(view, layoutAt, anchor, 1.3);
    expect(next.zoom).toBe(1.3);
    const after = layoutAt(1.3).pages[page.index]!;
    const s = pageToScreen(next, after, local);
    expect(s.x).toBeCloseTo(anchor.x, 6);
    expect(s.y).toBeCloseTo(anchor.y, 6);
  });
});

describe('pan clamping and alignment', () => {
  const content = { x: 0, y: 0, width: 1000, height: 3000 };
  const vp = { width: 800, height: 600 };

  it('centers an axis whose content fits', () => {
    const v = clampPan({ zoom: 0.5, panX: -999, panY: 0 }, content, vp, 48);
    expect(v.panX).toBe((800 - 500) / 2);
  });

  it('keeps the viewport center over the content when it does not fit', () => {
    const tooFar = clampPan({ zoom: 1, panX: 0, panY: 500 }, content, vp, 48);
    expect(tooFar.panY).toBe(300); // content top at the viewport center
    const tooFarUp = clampPan({ zoom: 1, panX: 0, panY: -10000 }, content, vp, 48);
    expect(tooFarUp.panY).toBe(300 - 3000);
    const inside = clampPan({ zoom: 1, panX: -100, panY: -1000 }, content, vp, 48);
    expect(inside).toEqual({ zoom: 1, panX: -100, panY: -1000 });
  });

  it('rounds the pan to device pixels', () => {
    expect(roundPan({ zoom: 1, panX: 10.3, panY: -4.74 }, 1)).toEqual({ zoom: 1, panX: 10, panY: -5 });
    expect(roundPan({ zoom: 1, panX: 10.3, panY: -4.74 }, 2)).toEqual({ zoom: 1, panX: 10.5, panY: -4.5 });
  });

  it('shows a page: centered when it fits, else top-left at the padding', () => {
    const l = computePageLayout(['a', 'b'], { width: 400, height: 400 }, 1, 1, 56);
    const b = l.pages[1]!;
    const fit = panToShowPage(b, 1, { width: 800, height: 600 }, 48);
    expect(fit).toEqual({ panX: 200, panY: 100 - b.y });
    const big = panToShowPage(b, 2, { width: 800, height: 600 }, 48);
    expect(big).toEqual({ panX: 48, panY: 48 - b.y * 2 });
    const v = { zoom: 1, ...fit };
    expect(pageVisibility(v, b, { width: 800, height: 600 })).toBe(1);
    expect(pageVisibility(v, l.pages[0]!, { width: 800, height: 600 })).toBeCloseTo(44 / 400, 9); // 100 - 56 px of page a show
    expect(pageAtViewportCenter(v, l, { width: 800, height: 600 })?.pageId).toBe('b');
  });
});

describe('misc helpers', () => {
  it('snap threshold is 6 screen px in page px', () => {
    expect(snapThresholdForZoom(0.5)).toBe(12);
    expect(snapThresholdForZoom(2)).toBe(3);
  });

  it('wheel deltas and zoom factor', () => {
    expect(wheelDeltaPx(3, 1)).toBe(48);
    expect(wheelDeltaPx(1, 2, 700)).toBe(700);
    expect(wheelDeltaPx(12, 0)).toBe(12);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(1000)).toBe(wheelZoomFactor(60));
  });

  it('rects', () => {
    expect(rectFromPoints({ x: 10, y: 5 }, { x: 2, y: 9 })).toEqual({ x: 2, y: 5, width: 8, height: 4 });
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 5, height: 5 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
  });
});
