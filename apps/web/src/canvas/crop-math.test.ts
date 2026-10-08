import { computeImageLayout, coverCrop, type CropRect } from '@plakat/schema';
import { describe, expect, it } from 'vitest';
import { beginCropSession, constrainCropDrag, constrainCropResize, cropFromRect, cropRectChanged } from './crop-math.ts';

const asset = { width: 2000, height: 1000 };
const box = { width: 400, height: 400, crop: null, objectFit: 'cover' as const, flipX: false, flipY: false };

function expectRect(a: CropRect, b: CropRect, digits = 6) {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.width).toBeCloseTo(b.width, digits);
  expect(a.height).toBeCloseTo(b.height, digits);
}

describe('beginCropSession', () => {
  it('places the whole image so the current (cover) crop fills the box', () => {
    const s = beginCropSession(box, asset);
    // cover of 2000×1000 into a square: crop 1000×1000 centered → k = 0.4
    expect(s.k).toBeCloseTo(0.4, 9);
    expectRect(s.ghost, { x: -200, y: 0, width: 800, height: 400 });
    expect(s.rect).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    expect(s.aspect).toBe(1);
  });

  it('starts from an explicit crop', () => {
    const s = beginCropSession({ ...box, crop: { x: 100, y: 100, width: 500, height: 500 } }, asset);
    expect(s.k).toBeCloseTo(0.8, 9);
    expectRect(s.ghost, { x: -80, y: -80, width: 1600, height: 800 });
  });

  it('starts contain/fill images from the largest centered crop with the box aspect', () => {
    const s = beginCropSession({ ...box, objectFit: 'contain' }, asset);
    expectRect(cropFromRect(s.rect, s), coverCrop(400, 400, 2000, 1000));
  });

  it('mirrors the ghost for flipped images', () => {
    const el = { ...box, crop: { x: 200, y: 0, width: 1000, height: 1000 }, flipX: true };
    const s = beginCropSession(el, asset);
    // unflipped ghost x = -80 (200 × 0.4), width 800 → mirrored about the box: 400 - (-80 + 800)
    expectRect(s.ghost, { x: -320, y: 0, width: 800, height: 400 });
  });
});

describe('cropFromRect', () => {
  it('maps the untouched rect back to the starting crop', () => {
    const crop = { x: 300, y: 50, width: 900, height: 900 };
    const s = beginCropSession({ ...box, crop }, asset);
    expectRect(cropFromRect(s.rect, s), crop);
  });

  it('maps a moved/zoomed rect to declared asset px', () => {
    const s = beginCropSession(box, asset); // ghost x=-200, k=0.4
    const crop = cropFromRect({ x: -100, y: 100, width: 200, height: 200 }, s);
    expectRect(crop, { x: 250, y: 250, width: 500, height: 500 });
    // the committed crop renders the same region the rect showed
    const layout = computeImageLayout({ width: 400, height: 400, crop, objectFit: 'cover' }, asset);
    expectRect(layout.crop, crop);
  });

  it('accounts for flips', () => {
    const s = beginCropSession({ ...box, flipX: true, flipY: true }, asset);
    // displayed rect at the displayed left edge of the ghost = asset's right edge
    const crop = cropFromRect({ x: s.ghost.x, y: 0, width: 400, height: 400 }, s);
    expectRect(crop, { x: 1000, y: 0, width: 1000, height: 1000 });
  });
});

describe('constraints', () => {
  const ghost = { x: -200, y: 0, width: 800, height: 400 };

  it('keeps a dragged rect inside the image', () => {
    expect(constrainCropDrag({ x: -500, y: 30, width: 400, height: 400 }, ghost)).toEqual({ x: -200, y: 0, width: 400, height: 400 });
    expect(constrainCropDrag({ x: 300, y: -30, width: 400, height: 400 }, ghost)).toEqual({ x: 200, y: 0, width: 400, height: 400 });
    expect(constrainCropDrag({ x: 10, y: 0, width: 200, height: 200 }, ghost)).toEqual({ x: 10, y: 0, width: 200, height: 200 });
  });

  it('resizes about the opposite corner, keeping the aspect', () => {
    const prev = { x: 0, y: 0, width: 400, height: 400 };
    const r = constrainCropResize({ x: 0, y: 0, width: 200, height: 260 }, prev, ghost, 1, 'bottom-right');
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(260);
    expect(r.height).toBe(260);
    const tl = constrainCropResize({ x: 100, y: 100, width: 300, height: 300 }, prev, ghost, 1, 'top-left');
    expect(tl.x + tl.width).toBe(400);
    expect(tl.y + tl.height).toBe(400);
    expect(tl.width).toBe(300);
  });

  it('never grows past the image (shrinks uniformly about the fixed corner)', () => {
    const prev = { x: 0, y: 0, width: 300, height: 300 };
    const r = constrainCropResize({ x: 0, y: 0, width: 900, height: 900 }, prev, ghost, 1, 'bottom-right');
    expect(r).toEqual({ x: 0, y: 0, width: 400, height: 400 }); // limited by the image height
    const left = constrainCropResize({ x: -600, y: 0, width: 900, height: 900 }, { x: 100, y: 0, width: 300, height: 300 }, ghost, 1, 'bottom-left');
    expect(left.x).toBe(0);
    expect(left.width).toBe(400);
    expect(left.x).toBeGreaterThanOrEqual(ghost.x);
  });

  it('enforces a minimum size and keeps non-square aspects', () => {
    const r = constrainCropResize({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 200, height: 100 }, ghost, 2, 'bottom-right', 8);
    expect(r.width).toBe(16);
    expect(r.height).toBe(8);
  });

  it('detects changes', () => {
    expect(cropRectChanged({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
    expect(cropRectChanged({ x: 0.1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 })).toBe(true);
  });
});
