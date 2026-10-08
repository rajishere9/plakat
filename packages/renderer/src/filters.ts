import type { ImageFilters } from '@plakat/schema';
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

/** Re-caches when the node has filters, drops any cache otherwise (unfiltered images are never cached). */
export function syncFilterCache(node: KonvaImage, pixelRatio: number): void {
  if ((node.filters()?.length ?? 0) > 0) cacheFilteredNode(node, pixelRatio);
  else if (node.isCached()) node.clearCache();
}
