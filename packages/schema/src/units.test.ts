import { describe, expect, it } from 'vitest';
import { PAGE_PRESETS, presetToPageSize } from './presets.ts';
import {
  checkCanvasLimits,
  EXPORT_SCALES,
  exportPixelSize,
  fromPx,
  mmToPx,
  pdfPageLayout,
  pdfPageSizePt,
  PDF_MAX_PAGE_UNITS,
  SAFARI_CANVAS_LIMITS,
  toPx,
} from './units.ts';

/** The table in docs/render-export-pipeline.md — keep in sync. */
const EXPECTED: Record<string, Record<'1x' | '2x' | 'print', [number, number]>> = {
  'instagram-post': { '1x': [1080, 1080], '2x': [2160, 2160], print: [3375, 3375] },
  'instagram-story': { '1x': [1080, 1920], '2x': [2160, 3840], print: [3375, 6000] },
  'youtube-thumbnail': { '1x': [1280, 720], '2x': [2560, 1440], print: [4000, 2250] },
  'a4-poster': { '1x': [794, 1123], '2x': [1587, 2245], print: [2480, 3508] },
  'business-card': { '1x': [336, 192], '2x': [672, 384], print: [1050, 600] },
  'business-card-eu': { '1x': [321, 208], '2x': [643, 416], print: [1004, 650] },
};

describe('exportPixelSize', () => {
  it('covers every preset', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(PAGE_PRESETS.map((p) => p.id).sort());
  });

  for (const preset of PAGE_PRESETS) {
    for (const scale of ['1x', '2x', 'print'] as const) {
      it(`${preset.id} @ ${scale}`, () => {
        const size = presetToPageSize(preset.id);
        const px = exportPixelSize(size, scale);
        expect([px.width, px.height]).toEqual(EXPECTED[preset.id]![scale]);
        expect(px.pixelRatio).toBe(EXPORT_SCALES[scale]);
        // the page box maps exactly onto the W x H bitmap
        expect(size.width * px.pixelRatio * px.contentScaleX).toBeCloseTo(px.width, 9);
        expect(size.height * px.pixelRatio * px.contentScaleY).toBeCloseTo(px.height, 9);
        // the correction never exceeds half an output pixel
        expect(Math.abs(px.contentScaleX - 1) * px.width).toBeLessThanOrEqual(0.5 + 1e-9);
        expect(Math.abs(px.contentScaleY - 1) * px.height).toBeLessThanOrEqual(0.5 + 1e-9);
      });
    }
  }

  it('print scale is 300/96', () => {
    expect(EXPORT_SCALES.print).toBe(3.125);
  });

  it('rounds half up and removes float noise instead of truncating like Konva', () => {
    expect(exportPixelSize({ width: 100, height: 100 }, 3.125)).toMatchObject({ width: 313, height: 313 });
    // 0.1 * 3 = 0.30000000000000004 style noise must not flip a .5 boundary
    expect(exportPixelSize({ width: 0.5, height: 1.5 }, 1)).toMatchObject({ width: 1, height: 2 });
    expect(exportPixelSize({ width: 793.6, height: 10 }, 3.125).width).toBe(2480);
    expect(exportPixelSize({ width: 0.1, height: 0.1 }, 1)).toMatchObject({ width: 1, height: 1 });
  });

  it('accepts custom numeric scales and rejects invalid ones', () => {
    expect(exportPixelSize({ width: 1080, height: 1920 }, 0.5)).toMatchObject({ width: 540, height: 960 });
    expect(() => exportPixelSize({ width: 10, height: 10 }, 0)).toThrow(RangeError);
    expect(() => exportPixelSize({ width: 10, height: 10 }, Number.NaN)).toThrow(RangeError);
  });
});

describe('unit conversions', () => {
  it('converts between px, mm, in and pt at 96 px/in', () => {
    expect(toPx(1, 'in')).toBe(96);
    expect(toPx(72, 'pt')).toBe(96);
    expect(mmToPx(25.4)).toBeCloseTo(96, 12);
    expect(fromPx(96, 'mm')).toBeCloseTo(25.4, 12);
    expect(fromPx(96, 'pt')).toBe(72);
  });

  it('computes PDF page sizes in points from the physical size', () => {
    const a4 = pdfPageSizePt(presetToPageSize('a4-poster'));
    expect(a4.width).toBeCloseTo(595.2756, 3);
    expect(a4.height).toBeCloseTo(841.8898, 3);
    expect(pdfPageSizePt(presetToPageSize('business-card'))).toEqual({ width: 252, height: 144 });
    expect(pdfPageSizePt(presetToPageSize('instagram-post'))).toEqual({ width: 810, height: 810 });
  });

  it('flags outputs that exceed canvas limits', () => {
    const story = exportPixelSize(presetToPageSize('instagram-story'), 'print');
    expect(checkCanvasLimits(story)).toBeNull();
    expect(checkCanvasLimits(story, SAFARI_CANVAS_LIMITS)).toMatch(/maximum canvas area/);
    expect(checkCanvasLimits({ width: 40_000, height: 10 })).toMatch(/maximum canvas side/);
  });
});

describe('fractional pages map exactly onto the bitmap (no edge seam)', () => {
  it('content scale makes the page box cover W x H device pixels', () => {
    const a4 = presetToPageSize('a4-poster');
    const px1 = exportPixelSize(a4, '1x');
    expect(px1.width).toBe(794);
    // a full-bleed element (0..page.width) ends exactly at the bitmap edge
    expect(a4.width * px1.pixelRatio * px1.contentScaleX).toBeCloseTo(794, 9);
    expect(px1.contentScaleX).toBeCloseTo(794 / 793.7007874015748, 12);
    const eu = exportPixelSize(presetToPageSize('business-card-eu'), '2x');
    expect(eu.width).toBe(643);
    expect(321.25984251968504 * 2 * eu.contentScaleX).toBeCloseTo(643, 9);
    // integer pages at integer scales: exactly 1
    expect(exportPixelSize(presetToPageSize('instagram-post'), '2x')).toMatchObject({ contentScaleX: 1, contentScaleY: 1 });
  });
});

describe('pdfPageLayout', () => {
  it('passes orientation explicitly so jsPDF does not swap landscape pages', () => {
    expect(pdfPageLayout(presetToPageSize('youtube-thumbnail'))).toEqual({ width: 960, height: 540, orientation: 'landscape', userUnit: 1 });
    expect(pdfPageLayout(presetToPageSize('business-card'))).toEqual({ width: 252, height: 144, orientation: 'landscape', userUnit: 1 });
    const eu = pdfPageLayout(presetToPageSize('business-card-eu'));
    expect(eu.orientation).toBe('landscape');
    expect(eu.width).toBeCloseTo(240.94, 2);
    expect(pdfPageLayout(presetToPageSize('a4-poster')).orientation).toBe('portrait');
    expect(pdfPageLayout(presetToPageSize('instagram-post')).orientation).toBe('portrait');
  });

  it('uses a PDF UserUnit for pages larger than 14 400 pt', () => {
    const big = pdfPageLayout({ width: 20_000, height: 100, physical: null }); // 15 000 pt
    expect(big.userUnit).toBe(2);
    expect(big.width).toBe(7_500);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(PDF_MAX_PAGE_UNITS);
    const huge = pdfPageLayout({ width: 1, height: 1, physical: { width: 10_000, height: 10, unit: 'mm' } }); // 28 346 pt
    expect(huge.userUnit).toBe(2);
    expect(huge.width * huge.userUnit).toBeCloseTo(28_346.46, 1);
    expect(pdfPageLayout({ width: 19_200, height: 10, physical: null }).userUnit).toBe(1); // exactly 14 400 pt
  });
});
