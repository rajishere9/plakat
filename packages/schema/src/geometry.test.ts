import { describe, expect, it } from 'vitest';
import { createShapeElement, createTextElement } from './factory.ts';
import {
  bakeTransform,
  compareDecodedSize,
  computeImageLayout,
  fitCropToImage,
  transformerConstraints,
  coverCrop,
  getElementBounds,
  getElementCenter,
  getElementCorners,
  getPointsBounds,
  getSelectionBounds,
  getShapePoints,
  getSnapEdges,
  moveBoundsTo,
  normalizeRotation,
  rotateAroundCenter,
} from './geometry.ts';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('rotated boxes (rotation about the top-left origin, clockwise, like Konva)', () => {
  it('unrotated bounds equal the box', () => {
    expect(getElementBounds({ x: 10, y: 20, width: 100, height: 50, rotation: 0 })).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('90 degrees swings the box down-left of the origin', () => {
    const box = { x: 100, y: 100, width: 200, height: 50, rotation: 90 };
    const [tl, tr, br, bl] = getElementCorners(box);
    close(tl.x, 100); close(tl.y, 100);
    close(tr.x, 100); close(tr.y, 300);
    close(br.x, 50); close(br.y, 300);
    close(bl.x, 50); close(bl.y, 100);
    const b = getElementBounds(box);
    close(b.x, 50); close(b.y, 100); close(b.width, 50); close(b.height, 200);
  });

  it('45 degrees on a square grows the AABB by sqrt(2)', () => {
    const b = getElementBounds({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    close(b.width, 100 * Math.SQRT2);
    close(b.height, 100 * Math.SQRT2);
    close(b.x, -50 * Math.SQRT2);
    close(b.y, 0);
  });

  it('rotateAroundCenter keeps the visual center fixed', () => {
    const box = { x: 40, y: 60, width: 120, height: 80, rotation: 0 };
    const c0 = getElementCenter(box);
    for (const r of [30, 90, 180, -45, 270]) {
      const next = { ...box, ...rotateAroundCenter(box, r) };
      const c = getElementCenter(next);
      close(c.x, c0.x); close(c.y, c0.y);
      expect(next.rotation).toBe(r);
    }
    // 180 about center: origin moves to the opposite corner
    const flipped = rotateAroundCenter(box, 180);
    close(flipped.x, 160); close(flipped.y, 140);
  });

  it('moveBoundsTo aligns the AABB of a rotated element', () => {
    const box = { x: 100, y: 100, width: 200, height: 50, rotation: 90 };
    const moved = { ...box, ...moveBoundsTo(box, { x: 0, y: 0 }) };
    const b = getElementBounds(moved);
    close(b.x, 0); close(b.y, 0);
  });

  it('selection bounds, snap edges and rotation normalization', () => {
    expect(getSelectionBounds([])).toBeNull();
    expect(
      getSelectionBounds([
        { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
        { x: 50, y: 20, width: 10, height: 30, rotation: 0 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 60, height: 50 });
    expect(getSnapEdges({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: [10, 60, 110], y: [20, 40, 60] });
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(720)).toBe(0);
    expect(normalizeRotation(-360)).toBe(0);
  });
});

describe('shape points', () => {
  const boundsOf = (pts: number[]) => getPointsBounds(pts.reduce<{ x: number; y: number }[]>((acc, v, i) => (i % 2 ? (acc[acc.length - 1]!.y = v, acc) : [...acc, { x: v, y: 0 }]), []));

  it('polygons and stars fill their box exactly', () => {
    for (const [shape, sides] of [['polygon', 3], ['polygon', 5], ['polygon', 6], ['star', 5], ['star', 12]] as const) {
      const pts = getShapePoints(shape, 300, 200, sides, 0.4)!;
      expect(pts).toHaveLength((shape === 'star' ? sides * 2 : sides) * 2);
      const b = boundsOf(pts);
      close(b.x, 0); close(b.y, 0); close(b.width, 300); close(b.height, 200);
    }
  });

  it('triangle, line, rect and ellipse', () => {
    expect(getShapePoints('triangle', 100, 80)).toEqual([50, 0, 100, 80, 0, 80]);
    expect(getShapePoints('line', 100, 10)).toEqual([0, 5, 100, 5]);
    expect(getShapePoints('rect', 1, 1)).toBeNull();
    expect(getShapePoints('ellipse', 1, 1)).toBeNull();
  });
});

describe('image layout', () => {
  it('cover crops the center of the source', () => {
    expect(computeImageLayout({ width: 100, height: 100, crop: null, objectFit: 'cover' }, { width: 400, height: 200 })).toEqual({
      crop: { x: 100, y: 0, width: 200, height: 200 },
      dest: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(coverCrop(200, 100, 400, 400)).toEqual({ x: 0, y: 100, width: 400, height: 200 });
  });

  it('contain letterboxes inside the box', () => {
    expect(computeImageLayout({ width: 100, height: 100, crop: null, objectFit: 'contain' }, { width: 400, height: 200 })).toEqual({
      crop: { x: 0, y: 0, width: 400, height: 200 },
      dest: { x: 0, y: 25, width: 100, height: 50 },
    });
  });

  it('explicit crop is clamped and stretched to the box; fill uses the whole image', () => {
    expect(
      computeImageLayout({ width: 50, height: 50, crop: { x: 300, y: 150, width: 200, height: 200 }, objectFit: 'cover' }, { width: 400, height: 200 }),
    ).toEqual({ crop: { x: 300, y: 150, width: 100, height: 50 }, dest: { x: 0, y: 0, width: 50, height: 50 } });
    expect(computeImageLayout({ width: 10, height: 90, crop: null, objectFit: 'fill' }, { width: 400, height: 200 }).crop).toEqual({ x: 0, y: 0, width: 400, height: 200 });
  });
});

describe('image layout vs decoded size', () => {
  const el = { width: 100, height: 100, objectFit: 'cover' as const };

  it('scales explicit crops and cover crops to a different-resolution rendition', () => {
    const crop = { x: 100, y: 50, width: 200, height: 100 };
    const declared = { width: 400, height: 200 };
    expect(computeImageLayout({ ...el, crop }, declared, { width: 200, height: 100 }).crop).toEqual({ x: 50, y: 25, width: 100, height: 50 });
    expect(computeImageLayout({ ...el, crop: null }, declared, { width: 800, height: 400 }).crop).toEqual({ x: 200, y: 0, width: 400, height: 400 });
    // identical sizes: untouched
    expect(computeImageLayout({ ...el, crop }, declared).crop).toEqual(crop);
  });

  it('never hands Konva a degenerate crop (falls back to cover)', () => {
    const layout = computeImageLayout({ ...el, crop: { x: 500, y: 0, width: 10, height: 10 } }, { width: 400, height: 200 });
    expect(layout.crop.width).toBeGreaterThan(0);
    expect(layout.crop).toEqual({ x: 100, y: 0, width: 200, height: 200 });
  });

  it('compareDecodedSize flags aspect mismatches (un-baked EXIF rotation)', () => {
    expect(compareDecodedSize({ width: 4000, height: 3000 }, { width: 3000, height: 4000 }).aspectMismatch).toBe(true);
    expect(compareDecodedSize({ width: 4000, height: 3000 }, { width: 400, height: 300 })).toEqual({ scaleX: 0.1, scaleY: 0.1, aspectMismatch: false });
  });

  it('fitCropToImage keeps aspect and stays inside the image', () => {
    const fitted = fitCropToImage({ x: 300, y: 100, width: 300, height: 150 }, 400, 200);
    close(fitted.width / fitted.height, 2);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(400 + 1e-9);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(200 + 1e-9);
    expect(fitted.x).toBeGreaterThanOrEqual(0);
    // explicit box aspect
    const square = fitCropToImage({ x: 0, y: 0, width: 400, height: 200 }, 400, 200, 1);
    expect(square).toEqual({ x: 100, y: 0, width: 200, height: 200 });
    // already valid: unchanged
    expect(fitCropToImage({ x: 10, y: 10, width: 100, height: 50 }, 400, 200)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });
});

describe('bakeTransform & transformer constraints', () => {
  const text = { ...createTextElement({ fontSize: 40, width: 200, height: 48 }), x: 0, y: 0 };
  const rect = createShapeElement('rect', { width: 100, height: 50, strokeWidth: 3 });

  it('bakes scale into size; uniform text scaling multiplies fontSize', () => {
    const t = bakeTransform(text, { x: 5, y: 6, rotation: 10, scaleX: 1.5, scaleY: 1.5 });
    expect(t).toMatchObject({ x: 5, y: 6, rotation: 10, width: 300, height: 72, fontSize: 60, letterSpacing: text.letterSpacing });
    const side = bakeTransform(text, { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 1 });
    expect(side).toMatchObject({ width: 400, height: 48, fontSize: 40 });
    const r = bakeTransform(rect, { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 3 });
    expect(r).toMatchObject({ width: 200, height: 150, strokeWidth: 3 });
  });

  it('normalizes double negative scale and rejects skew / mirroring', () => {
    expect(bakeTransform(rect, { x: 1, y: 2, rotation: 20, scaleX: -1, scaleY: -2 })).toMatchObject({ rotation: 200, width: 100, height: 100 });
    expect(() => bakeTransform(rect, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0.2 })).toThrow(/Skew/);
    expect(() => bakeTransform(rect, { x: 0, y: 0, rotation: 0, scaleX: -1, scaleY: 1 })).toThrow(/Mirroring/);
  });

  it('constrains multi-selections containing rotated elements to uniform corner scaling', () => {
    expect(transformerConstraints([{ type: 'shape', rotation: 15 }, { type: 'shape', rotation: 0 }])).toMatchObject({ keepRatio: true, enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] });
    expect(transformerConstraints([{ type: 'shape', rotation: 90 }, { type: 'shape', rotation: 180 }]).keepRatio).toBe(false);
    expect(transformerConstraints([{ type: 'text', rotation: 0 }]).enabledAnchors).toEqual(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right']);
    expect(transformerConstraints([{ type: 'shape', rotation: 33 }]).keepRatio).toBe(false);
  });
});
