import { createTextElement } from '@plakat/schema';
import { describe, expect, it } from 'vitest';
import { applyMatrix, computeTextOverlayStyle, multiplyMatrix, textOverlayMatrix, type Matrix } from './text-overlay.ts';

const base = createTextElement({
  x: 100,
  y: 50,
  width: 300,
  height: 80,
  fontFamily: 'Inter',
  fontSize: 40,
  fontWeight: 700,
  fontStyle: 'italic',
  lineHeight: 1.25,
  letterSpacing: 0.05,
  align: 'center',
  fill: '#112233',
  textTransform: 'uppercase',
  textDecoration: 'underline',
  opacity: 0.8,
});

describe('textOverlayMatrix', () => {
  it('maps the text box origin to the element origin on screen (no rotation)', () => {
    const m = textOverlayMatrix({ element: base, pageOrigin: { x: 20, y: 30 }, zoom: 0.5 });
    expect(applyMatrix(m, { x: 0, y: 0 })).toEqual({ x: 20 + 50, y: 30 + 25 });
    // page px inside the box are scaled by zoom
    const p = applyMatrix(m, { x: 300, y: 80 });
    expect(p.x).toBeCloseTo(70 + 150, 9);
    expect(p.y).toBeCloseTo(55 + 40, 9);
  });

  it('applies the vertical-align offset inside the rotated, scaled box', () => {
    const el = { ...base, rotation: 90 };
    const m = textOverlayMatrix({ element: el, pageOrigin: { x: 0, y: 0 }, zoom: 2, textOffsetY: 10 });
    const origin = applyMatrix(m, { x: 0, y: 0 });
    // offset 10 page px along the element's local y, which points to screen -x after 90°
    expect(origin.x).toBeCloseTo(200 - 20, 9);
    expect(origin.y).toBeCloseTo(100, 9);
    const right = applyMatrix(m, { x: 1, y: 0 });
    expect(right.x - origin.x).toBeCloseTo(0, 9);
    expect(right.y - origin.y).toBeCloseTo(2, 9);
  });

  it('matches Konva-style rotation about the element origin', () => {
    const el = { ...base, rotation: 30 };
    const m = textOverlayMatrix({ element: el, pageOrigin: { x: 5, y: 7 }, zoom: 1 });
    const corner = applyMatrix(m, { x: el.width, y: 0 });
    const rad = (30 * Math.PI) / 180;
    expect(corner.x).toBeCloseTo(5 + el.x + el.width * Math.cos(rad), 9);
    expect(corner.y).toBeCloseTo(7 + el.y + el.width * Math.sin(rad), 9);
  });

  it('multiplies matrices in CSS order', () => {
    const t: Matrix = [1, 0, 0, 1, 10, 0];
    const s: Matrix = [2, 0, 0, 2, 0, 0];
    expect(applyMatrix(multiplyMatrix(t, s), { x: 1, y: 1 })).toEqual({ x: 12, y: 2 });
    expect(applyMatrix(multiplyMatrix(s, t), { x: 1, y: 1 })).toEqual({ x: 22, y: 2 });
  });
});

describe('computeTextOverlayStyle', () => {
  it('lays out in page px exactly like the renderer feeds Konva', () => {
    const style = computeTextOverlayStyle({ element: base, pageOrigin: { x: 0, y: 0 }, zoom: 0.5, textWidth: 310, textHeight: 120, textOffsetY: 0 });
    expect(style.fontSize).toBe('40px');
    expect(style.fontWeight).toBe(700);
    expect(style.fontStyle).toBe('italic');
    expect(style.fontFamily).toBe('"Inter", sans-serif');
    expect(style.lineHeight).toBe(1.25);
    expect(style.letterSpacing).toBe('2px'); // 0.05 em × 40 px
    expect(style.textAlign).toBe('center');
    expect(style.textTransform).toBe('uppercase');
    expect(style.textDecoration).toBe('underline');
    expect(style.color).toBe('#112233');
    expect(style.opacity).toBe(0.8);
    expect(style.width).toBe('310px');
    expect(style.height).toBe('120px');
    expect(style.transformOrigin).toBe('0 0');
    expect(style.transform).toBe('matrix(0.5, 0, 0, 0.5, 50, 25)');
    expect(style.whiteSpace).toBe('pre-wrap');
  });

  it('never collapses below one line and uses the element width by default', () => {
    const style = computeTextOverlayStyle({ element: { ...base, textTransform: 'none', textDecoration: 'none', align: 'justify' }, pageOrigin: { x: 0, y: 0 }, zoom: 1 });
    expect(style.width).toBe('300px');
    expect(style.height).toBe('50px'); // 40 × 1.25
    expect(style.textTransform).toBe('none');
    expect(style.textDecoration).toBe('none');
    expect(style.textAlignLast).toBe('left');
  });

  it('escapes quotes in family names', () => {
    const style = computeTextOverlayStyle({ element: { ...base, fontFamily: 'Bad"Font' }, pageOrigin: { x: 0, y: 0 }, zoom: 1 });
    expect(style.fontFamily).toBe('"BadFont", sans-serif');
  });
});
