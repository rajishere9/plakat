import type { PageSize, PhysicalSize, PhysicalUnit } from './types.ts';

/** Document space is CSS px at 96 px per inch. */
export const PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;
/** Print export resolution. */
export const PRINT_DPI = 300;

export type Unit = 'px' | 'mm' | 'in' | 'pt';

export const mmToPx = (mm: number): number => (mm / MM_PER_INCH) * PX_PER_INCH;
export const inToPx = (inches: number): number => inches * PX_PER_INCH;
export const ptToPx = (pt: number): number => (pt / PT_PER_INCH) * PX_PER_INCH;
export const pxToMm = (px: number): number => (px / PX_PER_INCH) * MM_PER_INCH;
export const pxToIn = (px: number): number => px / PX_PER_INCH;
export const pxToPt = (px: number): number => (px / PX_PER_INCH) * PT_PER_INCH;
export const mmToPt = (mm: number): number => (mm / MM_PER_INCH) * PT_PER_INCH;
export const inToPt = (inches: number): number => inches * PT_PER_INCH;

/** Converts a length in any supported unit to document px (no rounding). */
export function toPx(value: number, unit: Unit): number {
  switch (unit) {
    case 'px':
      return value;
    case 'mm':
      return mmToPx(value);
    case 'in':
      return inToPx(value);
    case 'pt':
      return ptToPx(value);
  }
}

/** Converts document px to any supported unit (no rounding). */
export function fromPx(px: number, unit: Unit): number {
  switch (unit) {
    case 'px':
      return px;
    case 'mm':
      return pxToMm(px);
    case 'in':
      return pxToIn(px);
    case 'pt':
      return pxToPt(px);
  }
}

/** Physical size -> exact (unrounded) document px. */
export function physicalToPx(physical: PhysicalSize): { width: number; height: number } {
  return { width: toPx(physical.width, physical.unit), height: toPx(physical.height, physical.unit) };
}

export const EXPORT_SCALES = {
  '1x': 1,
  '2x': 2,
  print: PRINT_DPI / PX_PER_INCH, // 3.125
} as const;

export type ExportScaleId = keyof typeof EXPORT_SCALES;

export function resolveExportScale(scale: number | ExportScaleId): number {
  const s = typeof scale === 'number' ? scale : EXPORT_SCALES[scale];
  if (!Number.isFinite(s) || s <= 0) throw new RangeError(`Invalid export scale: ${String(scale)}`);
  return s;
}

/** Snap to 1e-6 to remove float noise (e.g. 2479.9999999996) before rounding. */
function snap(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export interface ExportPixelSize {
  /** Exact output bitmap width in device pixels. */
  width: number;
  /** Exact output bitmap height in device pixels. */
  height: number;
  /** The nominal scale `s` (document px -> device px). Used for toCanvas/SceneCanvas and filter caches. */
  pixelRatio: number;
  /**
   * Correction applied to the page content (PageScene's content group) so the page box
   * (size.width x size.height) maps EXACTLY onto width x height device pixels:
   * contentScaleX = width / (size.width * s). 1 for integer pages at integer scales;
   * otherwise within 0.5 / width of 1 (A4 @ 1x: 0.99962). Without it the bitmap edge
   * would cut through the last pixel column/row, blending in the background (a seam).
   */
  contentScaleX: number;
  contentScaleY: number;
}

/**
 * THE rounding rule for every raster render (editor parity renders and exports):
 *   W = max(1, round_half_up(snap(page.width  * s)))
 *   H = max(1, round_half_up(snap(page.height * s)))
 *   contentScaleX = W / (page.width * s), contentScaleY = H / (page.height * s)
 * The bitmap is W x H; the page box is scaled by s * contentScale onto it exactly.
 */
export function exportPixelSize(
  size: Pick<PageSize, 'width' | 'height'>,
  scale: number | ExportScaleId,
): ExportPixelSize {
  const s = resolveExportScale(scale);
  const width = Math.max(1, Math.round(snap(size.width * s)));
  const height = Math.max(1, Math.round(snap(size.height * s)));
  return {
    width,
    height,
    pixelRatio: s,
    contentScaleX: width / (size.width * s),
    contentScaleY: height / (size.height * s),
  };
}

/** PDF page size in points. Uses the physical size when present (exact), else px * 0.75. */
export function pdfPageSizePt(size: Pick<PageSize, 'width' | 'height' | 'physical'>): {
  width: number;
  height: number;
} {
  if (size.physical) {
    const conv = (v: number, unit: PhysicalUnit) => (unit === 'mm' ? mmToPt(v) : inToPt(v));
    return { width: conv(size.physical.width, size.physical.unit), height: conv(size.physical.height, size.physical.unit) };
  }
  return { width: pxToPt(size.width), height: pxToPt(size.height) };
}

/** jsPDF (and PDF viewers) cap a page side at 14 400 user units. */
export const PDF_MAX_PAGE_UNITS = 14_400;

export interface PdfPageLayout {
  /** Page width/height in PDF user units (= pt / userUnit). Pass as jsPDF `format`. */
  width: number;
  height: number;
  /** jsPDF swaps width/height to match `orientation`, so it MUST be passed explicitly. */
  orientation: 'portrait' | 'landscape';
  /** 1 normally; an integer > 1 (PDF 1.6 /UserUnit) only for pages larger than 14 400 pt. */
  userUnit: number;
}

/**
 * Everything the PDF writer needs per page:
 *   new jsPDF({ unit: 'pt', format: [width, height], orientation, userUnit })
 *   doc.addPage([width, height], orientation)
 *   doc.addImage(canvas, 'PNG', 0, 0, width, height, undefined, 'FAST')
 */
export function pdfPageLayout(size: Pick<PageSize, 'width' | 'height' | 'physical'>): PdfPageLayout {
  const pt = pdfPageSizePt(size);
  const userUnit = Math.max(1, Math.ceil(Math.max(pt.width, pt.height) / PDF_MAX_PAGE_UNITS - 1e-9));
  return {
    width: pt.width / userUnit,
    height: pt.height / userUnit,
    orientation: pt.width > pt.height ? 'landscape' : 'portrait',
    userUnit,
  };
}

export interface CanvasLimits {
  maxSide: number;
  maxArea: number;
}

/** Chromium / Firefox desktop limits. */
export const DEFAULT_CANVAS_LIMITS: CanvasLimits = { maxSide: 32_767, maxArea: 268_435_456 };
/** Safari (macOS + iOS) area cap: 16,777,216 px (4096 x 4096). */
export const SAFARI_CANVAS_LIMITS: CanvasLimits = { maxSide: 16_384, maxArea: 16_777_216 };

/** Returns null when the bitmap fits, or a human-readable reason when it does not. */
export function checkCanvasLimits(
  dims: { width: number; height: number },
  limits: CanvasLimits = DEFAULT_CANVAS_LIMITS,
): string | null {
  if (dims.width > limits.maxSide || dims.height > limits.maxSide) {
    return `Output ${dims.width}x${dims.height} exceeds the maximum canvas side of ${limits.maxSide}px`;
  }
  if (dims.width * dims.height > limits.maxArea) {
    return `Output ${dims.width}x${dims.height} (${dims.width * dims.height} px) exceeds the maximum canvas area of ${limits.maxArea} px`;
  }
  return null;
}
