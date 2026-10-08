import { createShapeElement } from '@plakat/schema';
import { describe, expect, it } from 'vitest';
import { cleanNodeTransform, elementsInMarquee, movedSelectionBounds, pastThreshold, rotationSnapConfig, snapAngle } from './interaction.ts';

describe('rotation snapping', () => {
  it('snaps every 15° with Shift (always), right angles otherwise', () => {
    const shift = rotationSnapConfig(true);
    expect(shift.rotationSnaps).toHaveLength(24);
    expect(shift.rotationSnaps[1]).toBe(15);
    expect(shift.rotationSnapTolerance).toBe(7.5);
    const free = rotationSnapConfig(false);
    expect(free.rotationSnaps).toEqual([0, 90, 180, 270]);
    expect(free.rotationSnapTolerance).toBeLessThan(7.5);
  });

  it('snapAngle', () => {
    expect(snapAngle(22)).toBe(15);
    expect(snapAngle(23)).toBe(30);
    expect(snapAngle(-8)).toBe(345);
    expect(snapAngle(359)).toBe(0);
  });
});

describe('elementsInMarquee', () => {
  const a = createShapeElement('rect', { id: 'a', x: 0, y: 0, width: 100, height: 100 });
  const b = createShapeElement('rect', { id: 'b', x: 200, y: 0, width: 100, height: 100 });
  const hidden = createShapeElement('rect', { id: 'h', x: 0, y: 0, width: 10, height: 10, hidden: true });
  const locked = createShapeElement('rect', { id: 'l', x: 0, y: 0, width: 10, height: 10, locked: true });
  const rotated = createShapeElement('rect', { id: 'r', x: 400, y: 0, width: 100, height: 10, rotation: 90 });
  const page = { elements: [a, b, hidden, locked, rotated] };

  it('selects intersecting, visible, unlocked elements', () => {
    expect(elementsInMarquee(page, { x: 50, y: 50, width: 200, height: 10 })).toEqual(['a', 'b']);
    expect(elementsInMarquee(page, { x: 0, y: 0, width: 5, height: 5 }, { includeLocked: true })).toEqual(['a', 'l']);
    expect(elementsInMarquee(page, { x: 0, y: 0, width: 0, height: 0 })).toEqual([]);
  });

  it('uses rotated bounds', () => {
    // rotated 90° about (400, 0): occupies x 390..400, y 0..100
    expect(elementsInMarquee(page, { x: 392, y: 50, width: 4, height: 4 })).toEqual(['r']);
    expect(elementsInMarquee(page, { x: 450, y: 2, width: 4, height: 4 })).toEqual([]);
  });

  it('movedSelectionBounds', () => {
    expect(movedSelectionBounds([a, b], 10, -5)).toEqual({ x: 10, y: -5, width: 300, height: 100 });
    expect(movedSelectionBounds([])).toBeNull();
  });
});

describe('cleanNodeTransform', () => {
  it('takes position/scale from the node, rotation from the frame, and drops skew', () => {
    const t = cleanNodeTransform({ x: 10, y: 20, scaleX: 2, scaleY: 1.5 }, 30);
    expect(t).toEqual({ x: 10, y: 20, rotation: 30, scaleX: 2, scaleY: 1.5, skewX: 0, skewY: 0 });
  });

  it('keeps the scale exactly 1 for a rotate-only gesture', () => {
    const t = cleanNodeTransform({ x: 1, y: 2, scaleX: 1.0004, scaleY: 0.9997 }, 45, { rotateOnly: true });
    expect(t.scaleX).toBe(1);
    expect(t.scaleY).toBe(1);
    expect(t.rotation).toBe(45);
  });

  it('pastThreshold', () => {
    expect(pastThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
  });
});
