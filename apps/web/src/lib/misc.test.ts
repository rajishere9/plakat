import { describe, expect, it } from 'vitest';
import { createImageElement } from '@plakat/schema';
import { initialCrop, remapCrop } from './crop.ts';
import { sanitizeElementPatch, sanitizeFilters } from './element-patch.ts';
import { adaptVariantToFamily, availableWeights, canToggleBold, getFontPickerGroups, searchFonts, toggledBoldWeight } from './fonts.ts';
import { clampZoom, computeFitZoom, nextZoomStep } from './zoom.ts';

describe('zoom', () => {
  it('steps, clamps and fits', () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
    expect(nextZoomStep(0.8, -1)).toBe(0.75);
    expect(nextZoomStep(8, 1)).toBe(8);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(computeFitZoom({ width: 1080, height: 1920 }, { width: 1000, height: 1000 }, 50)).toBeCloseTo(900 / 1920);
    expect(computeFitZoom({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
  });
});

describe('element patch sanitizer', () => {
  it('rejects unknown keys and clamps per type', () => {
    const img = createImageElement('as_x', { width: 10, height: 10 });
    const r = sanitizeElementPatch(img, { fontSize: 3, crop: { x: -5, y: 0, width: 5, height: 5 }, filters: { blur: 500 }, id: 'nope' });
    expect(r.rejected.sort()).toEqual(['fontSize', 'id']);
    expect(r.patch['crop']).toEqual({ x: 0, y: 0, width: 5, height: 5 });
    expect((r.patch['filters'] as { blur: number }).blur).toBe(100);
    expect(sanitizeFilters({ grayscale: 'yes', contrast: -200 })).toEqual({ contrast: -100 });
  });
});

describe('fonts', () => {
  it('catalog helpers', () => {
    expect(getFontPickerGroups()[0]!.category).toBe('sans-serif');
    expect(searchFonts('mont').map((f) => f.family)).toContain('Montserrat');
    expect(availableWeights('Lato')).toEqual([100, 300, 400, 700, 900]);
    expect(availableWeights('Some Custom Font')).toHaveLength(9);
    expect(adaptVariantToFamily('Lato', 500, 'italic')).toEqual({ fontWeight: 400, fontStyle: 'italic' });
    expect(toggledBoldWeight('Lato', 400, 'normal')).toBe(700);
    expect(toggledBoldWeight('Lato', 700, 'normal')).toBe(400);
    expect(canToggleBold('Lobster')).toBe(false);
  });
});

describe('crop helpers', () => {
  it('initialCrop follows objectFit; remapCrop keeps framing', () => {
    const el = createImageElement('as_x', { width: 400, height: 200 }, { width: 100, height: 100 });
    expect(initialCrop(el, { width: 400, height: 200 })).toEqual({ x: 100, y: 0, width: 200, height: 200 });
    expect(initialCrop({ ...el, objectFit: 'fill' }, { width: 400, height: 200 })).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(remapCrop(null, { width: 1, height: 1 }, { width: 2, height: 2 }, el)).toBeNull();
    expect(remapCrop({ x: 100, y: 0, width: 200, height: 200 }, { width: 400, height: 200 }, { width: 200, height: 100 }, el)).toEqual({
      x: 50,
      y: 0,
      width: 100,
      height: 100,
    });
  });
});
