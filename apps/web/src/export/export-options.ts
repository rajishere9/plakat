/** Pure helpers behind the export dialog (page ranges, output dimensions, limits). */
import { isWebKitBrowser } from '@plakat/renderer';
import {
  checkCanvasLimits,
  DEFAULT_CANVAS_LIMITS,
  exportPixelSize,
  pdfPageSizePt,
  pxToMm,
  SAFARI_CANVAS_LIMITS,
  type CanvasLimits,
  type ExportScaleId,
  type Id,
  type PageSize,
  type PlakatDocument,
} from '@plakat/schema';

export type ExportFormatId = 'png' | 'jpg' | 'pdf';
export type PageSelection = 'current' | 'all' | 'range';

export const FORMAT_OPTIONS: { value: ExportFormatId; label: string; description: string }[] = [
  { value: 'png', label: 'PNG', description: 'Best quality, keeps transparency' },
  { value: 'jpg', label: 'JPG', description: 'Smaller files, white background' },
  { value: 'pdf', label: 'PDF (image, 300 dpi)', description: 'For printing; each page is a 300 dpi image' },
];

export const SCALE_OPTIONS: { value: ExportScaleId; label: string }[] = [
  { value: '1x', label: '1×' },
  { value: '2x', label: '2×' },
  { value: 'print', label: 'Print (300 dpi)' },
];

/**
 * Parses "1-3, 5" (1-based, inclusive) into sorted unique page numbers within
 * 1..count. Returns an error string for empty/invalid/out-of-range input.
 */
export function parsePageRange(text: string, count: number): number[] | string {
  const parts = text
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'Enter pages, e.g. 1-3, 5';
  const out = new Set<number>();
  for (const part of parts) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) return `“${part}” is not a page number or range`;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo < 1 || hi > count) return count === 1 ? 'This design has only 1 page' : `Pages go from 1 to ${count}`;
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** Page ids to export (document order). */
export function resolvePageIds(doc: Pick<PlakatDocument, 'pages'>, selection: PageSelection, activePageId: Id, range: string): Id[] | string {
  if (selection === 'all') return doc.pages.map((p) => p.id);
  if (selection === 'current') {
    const p = doc.pages.find((x) => x.id === activePageId) ?? doc.pages[0];
    return p ? [p.id] : 'No page to export';
  }
  const nums = parsePageRange(range, doc.pages.length);
  if (typeof nums === 'string') return nums;
  return nums.map((n) => doc.pages[n - 1]!.id);
}

export function defaultScaleFor(format: ExportFormatId): ExportScaleId {
  return format === 'pdf' ? 'print' : '1x';
}

/** Canvas limits for this browser (WebKit caps canvas area at 16.7 MP). */
export function browserCanvasLimits(userAgent?: string): CanvasLimits {
  return isWebKitBrowser(userAgent) ? SAFARI_CANVAS_LIMITS : DEFAULT_CANVAS_LIMITS;
}

export interface ExportSummary {
  width: number;
  height: number;
  /** Human text, e.g. "2480 × 3508 px". */
  pixels: string;
  /** PDF page size text (PDF only), e.g. "210 × 297 mm (595.28 × 841.89 pt)". */
  pdfPage: string | null;
  /** Non-null when the bitmap exceeds the canvas limits. */
  limitWarning: string | null;
}

const fmt = (n: number, d = 2) => String(Math.round(n * 10 ** d) / 10 ** d);

export function exportSummary(size: PageSize, format: ExportFormatId, scale: ExportScaleId, limits: CanvasLimits = DEFAULT_CANVAS_LIMITS): ExportSummary {
  const dims = exportPixelSize(size, scale);
  let pdfPage: string | null = null;
  if (format === 'pdf') {
    const pt = pdfPageSizePt(size);
    const physical = size.physical ? `${fmt(size.physical.width)} × ${fmt(size.physical.height)} ${size.physical.unit}` : `${fmt(pxToMm(size.width), 1)} × ${fmt(pxToMm(size.height), 1)} mm`;
    pdfPage = `${physical} (${fmt(pt.width)} × ${fmt(pt.height)} pt)`;
  }
  const reason = checkCanvasLimits(dims, limits);
  return {
    width: dims.width,
    height: dims.height,
    pixels: `${dims.width} × ${dims.height} px`,
    pdfPage,
    limitWarning: reason ? `${reason}. Choose a smaller scale${scale === 'print' ? ' (2× or 1×)' : ''}.` : null,
  };
}
