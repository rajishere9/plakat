import { DEFAULT_CANVAS_LIMITS, SAFARI_CANVAS_LIMITS, type CanvasLimits, type ImageFilters } from '@plakat/schema';
import { isWebKitBrowser } from './env-browser.ts';
import { CanvasLimitError } from './errors.ts';
import { Konva, type KonvaFilter, type KonvaImage, type KonvaNode } from './konva.ts';

/** Konva `saturation` for a document saturation in -100..100 (§3.5; Konva applies 2^saturation). */
export function konvaSaturation(saturation: number): number {
  return saturation === 0 ? 0 : Math.log2(Math.max(1 + saturation / 100, 2 ** -10));
}

/** True when any filter is non-neutral (the node must then be cached, P-7). */
export function hasActiveFilters(f: ImageFilters): boolean {
  return f.brightness !== 0 || f.contrast !== 0 || f.saturation !== 0 || f.grayscale || f.sepia || f.invert || f.blur > 0;
}

/**
 * The Konva function-filter list (P-6) in the fixed order of §3.5, non-neutral ones only.
 */
export function konvaFilterList(f: ImageFilters): KonvaFilter[] {
  const F = Konva.Filters;
  const list: KonvaFilter[] = [];
  if (f.brightness !== 0) list.push(F.Brighten);
  if (f.contrast !== 0) list.push(F.Contrast);
  if (f.saturation !== 0) list.push(F.HSL);
  if (f.grayscale) list.push(F.Grayscale);
  if (f.sepia) list.push(F.Sepia);
  if (f.invert) list.push(F.Invert);
  if (f.blur > 0) list.push(F.Blur);
  return list;
}

/** Sets every filter attribute (neutral values included) and the filter list. Does not cache. */
export function applyFilterAttrs(node: KonvaImage, f: ImageFilters): void {
  node.setAttrs({
    image: node.image(),
    brightness: f.brightness / 100,
    contrast: f.contrast,
    hue: 0,
    saturation: konvaSaturation(f.saturation),
    luminance: 0,
    blurRadius: f.blur,
  });
  node.filters(konvaFilterList(f));
}

/** The P-7 cache padding: at least one logical px and at least one device px. */
export function filterCacheOffset(pixelRatio: number): number {
  return Math.max(1, Math.ceil(1 / pixelRatio));
}

/**
 * THE filter cache call (P-7): explicit pixelRatio equal to the effective output ratio,
 * padded so Konva's truncating bitmap size never cuts into the image.
 */
export function cacheFilteredNode(node: KonvaNode, pixelRatio: number): void {
  node.clearCache();
  node.cache({ pixelRatio, offset: filterCacheOffset(pixelRatio) });
}

/**
 * Area budget of one filter cache bitmap (8192², 64 MP ≈ 256 MB, plus the same again for
 * Konva's filter canvas and ImageData). Larger caches are first cropped to the visible
 * part of the image, then (editor) rendered at a lower ratio; see planFilterCache.
 */
export const FILTER_CACHE_MAX_AREA = 8192 * 8192;

/** Canvas limits of the current platform: Safari's 16.7 MP on WebKit, else Chromium/Firefox limits. */
export function platformCanvasLimits(): CanvasLimits {
  return isWebKitBrowser() ? SAFARI_CANVAS_LIMITS : DEFAULT_CANVAS_LIMITS;
}

/** What to do when a filter cache cannot fit the limits even when cropped to the visible part. */
export type FilterCacheOverflow = 'clamp' | 'error';

export interface FilterCacheOptions {
  /** Canvas limits (default platformCanvasLimits()). The cache budget is min(maxArea, FILTER_CACHE_MAX_AREA). */
  limits?: CanvasLimits;
  /**
   * 'clamp' (editor, default): lower the cache ratio until it fits, so the image stays
   * visible (slightly soft at extreme zoom). 'error' (export): throw CanvasLimitError
   * instead of writing a file in which the filtered image is missing or degraded.
   */
  overflow?: FilterCacheOverflow;
  /**
   * The part of the node that can be visible (the page clip mapped into node-local
   * coordinates), or null when unknown. Used only when the whole node does not fit.
   */
  visible?: { x: number; y: number; width: number; height: number } | null;
}

export interface FilterCachePlan {
  /** Node-local cache rect (before the P-7 offset padding); the whole node unless `cropped`. */
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
  offset: number;
  /** Device size of the cache bitmap (upper bound). */
  deviceWidth: number;
  deviceHeight: number;
  cropped: boolean;
  /** pixelRatio is lower than requested (editor only). */
  clamped: boolean;
}

type Rect = { x: number; y: number; width: number; height: number };

function deviceSize(rect: Rect, pixelRatio: number): { width: number; height: number; offset: number } {
  const offset = filterCacheOffset(pixelRatio);
  return {
    width: Math.ceil((rect.width + 2 * offset) * pixelRatio),
    height: Math.ceil((rect.height + 2 * offset) * pixelRatio),
    offset,
  };
}

/**
 * Smallest n ≤ 64 with n × pixelRatio an integer (print 3.125 → 8), else 1. A cropped
 * cache whose origin is a multiple of n sits on the same device-pixel grid as the
 * whole-node cache, so cropping does not resample the visible pixels.
 */
function gridStep(pixelRatio: number): number {
  for (let n = 1; n <= 64; n++) if (Math.abs(n * pixelRatio - Math.round(n * pixelRatio)) < 1e-9) return n;
  return 1;
}

function fits(d: { width: number; height: number }, limits: CanvasLimits): boolean {
  return d.width <= limits.maxSide && d.height <= limits.maxSide && d.width * d.height <= limits.maxArea;
}

/**
 * Decides how a filtered node is cached (P-7). In order:
 *  1. the whole node at `pixelRatio` (the normal case, and the only one for nodes that fit);
 *  2. only its visible part (page clip, padded by the blur radius), at `pixelRatio`;
 *  3. 'error': the visible part if it fits the hard canvas limits, else CanvasLimitError;
 *     'clamp': the visible part at the largest ratio that fits the budget.
 * Deterministic for a given (node geometry, page, ratio, limits), so the editor's
 * rasterizePage and the export path choose the same cache.
 */
export function planFilterCache(node: KonvaImage, pixelRatio: number, opts: FilterCacheOptions = {}): FilterCachePlan | null {
  const full: Rect = { x: 0, y: 0, width: Math.ceil(node.width()), height: Math.ceil(node.height()) };
  if (!(full.width > 0 && full.height > 0)) return null;
  const limits = opts.limits ?? platformCanvasLimits();
  const budget: CanvasLimits = { maxSide: limits.maxSide, maxArea: Math.min(limits.maxArea, FILTER_CACHE_MAX_AREA) };
  const plan = (rect: Rect, r: number, cropped: boolean): FilterCachePlan => {
    const d = deviceSize(rect, r);
    return { ...rect, pixelRatio: r, offset: d.offset, deviceWidth: d.width, deviceHeight: d.height, cropped, clamped: r !== pixelRatio };
  };
  if (fits(deviceSize(full, pixelRatio), budget)) return plan(full, pixelRatio, false);

  let rect = full;
  const vis = opts.visible;
  if (vis) {
    // Blur samples up to its radius (document px) around each pixel: keep that margin.
    const pad = Math.ceil(Math.min(node.blurRadius(), 180)) + 2;
    const n = gridStep(pixelRatio);
    const x0 = Math.max(0, Math.floor((vis.x - pad) / n) * n);
    const y0 = Math.max(0, Math.floor((vis.y - pad) / n) * n);
    const x1 = Math.min(full.width, Math.ceil(vis.x + vis.width + pad));
    const y1 = Math.min(full.height, Math.ceil(vis.y + vis.height + pad));
    rect = x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 1, height: 1 };
  }
  const cropped = rect.x !== 0 || rect.y !== 0 || rect.width !== full.width || rect.height !== full.height;
  const needed = deviceSize(rect, pixelRatio);
  if (fits(needed, budget)) return plan(rect, pixelRatio, cropped);
  if (opts.overflow === 'error') {
    if (fits(needed, limits)) return plan(rect, pixelRatio, cropped);
    const reason =
      `A filtered image needs a ${needed.width}x${needed.height} px filter cache at this scale, ` +
      `which exceeds the canvas limits (${limits.maxSide}px per side, ${limits.maxArea} px)`;
    throw new CanvasLimitError(needed.width, needed.height, reason);
  }
  let r = pixelRatio * Math.min(1, budget.maxSide / Math.max(needed.width, needed.height), Math.sqrt(budget.maxArea / (needed.width * needed.height)));
  for (let i = 0; i < 64 && !fits(deviceSize(rect, r), budget); i++) r *= 0.98;
  return plan(rect, r, cropped);
}

/**
 * Re-caches when the node has filters (planFilterCache), drops any cache otherwise
 * (unfiltered images are never cached). Returns the plan used, or null when uncached.
 */
export function syncFilterCache(node: KonvaImage, pixelRatio: number, opts: FilterCacheOptions = {}): FilterCachePlan | null {
  if ((node.filters()?.length ?? 0) === 0) {
    if (node.isCached()) node.clearCache();
    return null;
  }
  const p = planFilterCache(node, pixelRatio, opts);
  node.clearCache();
  if (!p) return null;
  if (!p.cropped) {
    // Identical to cacheFilteredNode at the plan's ratio (Konva derives the same rect).
    node.cache({ pixelRatio: p.pixelRatio, offset: p.offset });
  } else {
    node.cache({ x: p.x, y: p.y, width: p.width, height: p.height, pixelRatio: p.pixelRatio, offset: p.offset });
  }
  return p;
}
