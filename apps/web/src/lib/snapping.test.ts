import { describe, expect, it } from 'vitest';
import { createShapeElement } from '@plakat/schema';
import { computeResizeSnap, computeSnap, edgesForAnchor, getSnapTargets } from './snapping.ts';

const page = { width: 1000, height: 800 };

describe('computeSnap', () => {
  it('does nothing beyond the threshold', () => {
    const r = computeSnap({ x: 100, y: 100, width: 50, height: 50 }, { pageSize: page, others: [] }, 5);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [], spacing: [] });
  });

  it('snaps to page edges with full-length guides', () => {
    const r = computeSnap({ x: 3, y: 746, width: 50, height: 50 }, { pageSize: page, others: [] }, 5);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(4); // bottom 796 -> 800
    expect(r.guides).toEqual([
      { axis: 'x', position: 0, start: 0, end: 800, kind: 'page-edge' },
      { axis: 'y', position: 800, start: 0, end: 1000, kind: 'page-edge' },
    ]);
  });

  it('snaps the center to the page center', () => {
    const r = computeSnap({ x: 473, y: 10, width: 50, height: 20 }, { pageSize: page, others: [] }, 5);
    expect(r.dx).toBe(2); // center 498 -> 500
    expect(r.guides.find((g) => g.axis === 'x')).toMatchObject({ position: 500, kind: 'page-center' });
  });

  it('snaps to other elements edges/centers with guides spanning both', () => {
    const other = { x: 300, y: 300, width: 100, height: 100 };
    const r = computeSnap({ x: 402, y: 500, width: 50, height: 50 }, { pageSize: page, others: [other] }, 5, { page: false });
    expect(r.dx).toBe(-2); // left 402 -> other right 400
    expect(r.guides).toEqual([{ axis: 'x', position: 400, start: 300, end: 550, kind: 'element-edge' }]);
  });

  it('picks the smallest delta; ties prefer page center over element edges', () => {
    const moving = { x: 0, y: 0, width: 100, height: 10 };
    const r1 = computeSnap({ ...moving, x: 448 }, { pageSize: page, others: [{ x: 553, y: 0, width: 10, height: 10 }] }, 5, { y: false });
    expect(r1.dx).toBe(2); // center 498 -> 500 (|2|) vs right 548 -> 553 (|5|)
    const r2 = computeSnap({ ...moving, x: 448 }, { pageSize: page, others: [{ x: 550, y: 0, width: 10, height: 10 }] }, 5, { y: false });
    // right 548 -> 550 (+2) ties with center -> page center (+2): same delta, both guides shown
    expect(r2.dx).toBe(2);
    expect(r2.guides.map((g) => g.kind).sort()).toEqual(['element-edge', 'page-center']);
    const r3 = computeSnap({ ...moving, x: 450 + 2 }, { pageSize: page, others: [{ x: 554, y: 0, width: 10, height: 10 }] }, 5, { y: false });
    // center 502 -> 500 (-2) vs right 552 -> 554 (+2): tie on |delta| -> page center wins
    expect(r3.dx).toBe(-2);
    expect(r3.guides).toHaveLength(1);
    expect(r3.guides[0]!.kind).toBe('page-center');
  });

  it('merges coincident guides and respects axis toggles', () => {
    const others = [
      { x: 100, y: 0, width: 10, height: 10 },
      { x: 100, y: 500, width: 10, height: 10 },
    ];
    const r = computeSnap({ x: 101, y: 200, width: 30, height: 30 }, { pageSize: page, others }, 5, { page: false, equalSpacing: false });
    expect(r.dx).toBe(-1);
    expect(r.guides).toEqual([{ axis: 'x', position: 100, start: 0, end: 510, kind: 'element-edge' }]);
    const off = computeSnap({ x: 101, y: 200, width: 30, height: 30 }, { pageSize: page, others }, 5, { x: false, page: false });
    expect(off.dx).toBe(0);
  });

  it('threshold is in page px (screen px / zoom)', () => {
    const zoom = 0.5;
    const threshold = 6 / zoom; // 12 page px
    const r = computeSnap({ x: 10, y: 400, width: 50, height: 50 }, { pageSize: page, others: [] }, threshold, { y: false });
    expect(r.dx).toBe(-10);
  });

  it('equal spacing: centers between two neighbours', () => {
    const others = [
      { x: 0, y: 100, width: 100, height: 50 },
      { x: 300, y: 100, width: 100, height: 50 },
    ];
    // free room 100..300 for a 60 wide box -> x = 170
    const r = computeSnap({ x: 167, y: 600, width: 60, height: 50 }, { pageSize: { width: 5000, height: 5000 }, others }, 5, { page: false, y: false });
    expect(r.dx).toBe(0); // not on the same row: no spacing
    const r2 = computeSnap({ x: 167, y: 110, width: 60, height: 20 }, { pageSize: { width: 5000, height: 5000 }, others }, 5, { page: false, y: false });
    expect(r2.dx).toBe(3);
    expect(r2.spacing).toHaveLength(1);
    expect(r2.spacing[0]).toMatchObject({ axis: 'x', gap: 70 });
    expect(r2.spacing[0]!.segments.map((s) => [s.from, s.to])).toEqual([
      [100, 170],
      [230, 300],
    ]);
  });

  it('equal spacing: continues the gap of two neighbours', () => {
    const others = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 150, y: 0, width: 100, height: 100 },
    ];
    const r = computeSnap({ x: 297, y: 10, width: 80, height: 80 }, { pageSize: { width: 5000, height: 5000 }, others }, 5, { page: false, y: false });
    expect(r.dx).toBe(3); // gap 50 -> x = 300
    expect(r.spacing[0]).toMatchObject({ gap: 50 });
  });
});

describe('computeResizeSnap', () => {
  it('snaps only moving edges', () => {
    const others = [{ x: 500, y: 0, width: 10, height: 10 }];
    const r = computeResizeSnap({ x: 100, y: 100, width: 397, height: 50 }, edgesForAnchor('middle-right'), { pageSize: page, others }, 5);
    expect(r.rect).toEqual({ x: 100, y: 100, width: 400, height: 50 });
    expect(r.guides).toEqual([expect.objectContaining({ axis: 'x', position: 500 })]);
    const left = computeResizeSnap({ x: 3, y: 100, width: 97, height: 50 }, edgesForAnchor('top-left'), { pageSize: page, others: [] }, 5);
    expect(left.rect.x).toBe(0);
    expect(left.rect.width).toBe(100);
  });

  it('keeps the ratio when asked', () => {
    const r = computeResizeSnap({ x: 0, y: 0, width: 198, height: 99 }, edgesForAnchor('bottom-right'), { pageSize: { width: 200, height: 1000 }, others: [] }, 5, {
      keepRatio: true,
      y: true,
    });
    expect(r.rect.width).toBe(200);
    expect(r.rect.height).toBeCloseTo(100);
  });
});

describe('getSnapTargets', () => {
  it('uses rotated AABBs of visible, non-moving elements', () => {
    const a = createShapeElement('rect', { id: 'a', x: 100, y: 0, width: 100, height: 50, rotation: 90 });
    const b = createShapeElement('rect', { id: 'b', hidden: true });
    const c = createShapeElement('rect', { id: 'c' });
    const t = getSnapTargets({ elements: [a, b, c] }, ['c']);
    expect(t).toHaveLength(1);
    expect(t[0]!.x).toBeCloseTo(50);
    expect(t[0]!.width).toBeCloseTo(50);
    expect(t[0]!.height).toBeCloseTo(100);
  });
});
