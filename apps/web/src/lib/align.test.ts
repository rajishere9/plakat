import { describe, expect, it } from 'vitest';
import { createShapeElement, getElementBounds } from '@plakat/schema';
import { computeAlign, computeDistribute, toAlignUnits } from './align.ts';

const r = (id: string, x: number, y: number, w: number, h: number, extra = {}) => createShapeElement('rect', { id, x, y, width: w, height: h, ...extra });

describe('computeAlign', () => {
  it('aligns a single unit to the page', () => {
    const m = computeAlign(toAlignUnits([r('a', 10, 20, 100, 50)]), 'center', { width: 1000, height: 1000 });
    expect(m.get('a')).toEqual({ dx: 440, dy: 0 });
    const b = computeAlign(toAlignUnits([r('a', 10, 20, 100, 50)]), 'bottom', { width: 1000, height: 1000 });
    expect(b.get('a')).toEqual({ dx: 0, dy: 930 });
  });

  it('aligns several units to the selection bounds', () => {
    const els = [r('a', 0, 0, 10, 10), r('b', 100, 50, 20, 20)];
    const m = computeAlign(toAlignUnits(els), 'right', { width: 1000, height: 1000 });
    expect(m.get('a')).toEqual({ dx: 110, dy: 0 });
    expect(m.has('b')).toBe(false); // already aligned
    const mid = computeAlign(toAlignUnits(els), 'middle', { width: 1000, height: 1000 });
    expect(mid.get('a')!.dy).toBe(30); // bounds 0..70 -> center 35
    expect(mid.get('b')!.dy).toBe(-25);
  });

  it('uses rotated bounds (45°)', () => {
    const rot = r('a', 500, 500, 100, 100, { rotation: 45 });
    const m = computeAlign(toAlignUnits([rot]), 'left', { width: 1000, height: 1000 });
    const b = getElementBounds(rot);
    expect(b.x + m.get('a')!.dx).toBeCloseTo(0);
  });

  it('treats a group as one unit and skips fixed (locked) units', () => {
    const els = [r('a', 0, 0, 10, 10, { groupId: 'g' }), r('b', 50, 0, 10, 10, { groupId: 'g' }), r('l', 200, 0, 10, 10, { locked: true })];
    const units = toAlignUnits(els);
    expect(units.map((u) => u.ids)).toEqual([['a', 'b'], ['l']]);
    const m = computeAlign(units, 'right', { width: 1000, height: 1000 });
    expect(m.get('a')).toEqual({ dx: 150, dy: 0 });
    expect(m.get('b')).toEqual({ dx: 150, dy: 0 });
    expect(m.has('l')).toBe(false);
  });
});

describe('computeDistribute', () => {
  it('needs 3 units and equalizes gaps between AABBs', () => {
    expect(computeDistribute(toAlignUnits([r('a', 0, 0, 1, 1), r('b', 5, 0, 1, 1)]), 'horizontal').size).toBe(0);
    const m = computeDistribute(toAlignUnits([r('a', 0, 0, 10, 10), r('b', 0, 30, 10, 40), r('c', 0, 200, 10, 10), r('d', 0, 15, 10, 10)]), 'vertical');
    // order a(0-10) d(15-25) b(30-70) c(200-210): span 210, sizes 70 -> gap 140/3
    const gap = 140 / 3;
    expect(m.get('d')!.dy).toBeCloseTo(10 + gap - 15);
    expect(m.get('b')!.dy).toBeCloseTo(10 + gap + 10 + gap - 30);
    expect(m.has('a')).toBe(false);
    expect(m.has('c')).toBe(false);
  });

  it('distributes rotated elements by their bounds', () => {
    const rot = r('b', 100, 0, 40, 20, { rotation: 90 }); // AABB x 80..100
    const m = computeDistribute(toAlignUnits([r('a', 0, 0, 20, 20), rot, r('c', 300, 0, 20, 20)]), 'horizontal');
    const b = getElementBounds(rot);
    expect(b.x + m.get('b')!.dx).toBeCloseTo(150);
  });
});
