/** Zoom helpers. Zoom 1 = 100 % (one document px per CSS px). */

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/** Discrete steps used by zoom in / zoom out (Mod+= / Mod+-). */
export const ZOOM_STEPS: readonly number[] = [0.05, 0.1, 0.125, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5, 6, 8];

/** Default padding (CSS px, each side) kept around the page by zoom-to-fit. */
export const FIT_PADDING = 48;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Next step strictly above (`dir = 1`) or below (`dir = -1`) the current zoom. */
export function nextZoomStep(zoom: number, dir: 1 | -1): number {
  const EPS = 1e-6;
  if (dir === 1) return ZOOM_STEPS.find((s) => s > zoom + EPS) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STEPS[i]!;
    if (s < zoom - EPS) return s;
  }
  return MIN_ZOOM;
}

/**
 * Zoom that fits `content` (a page, or the page stack) into `viewport` with `padding`
 * CSS px on each side. Never above 1 unless `allowUpscale`.
 */
export function computeFitZoom(content: Size, viewport: Size, padding = FIT_PADDING, allowUpscale = false): number {
  const w = viewport.width - padding * 2;
  const h = viewport.height - padding * 2;
  if (content.width <= 0 || content.height <= 0 || w <= 0 || h <= 0) return clampZoom(1);
  const z = Math.min(w / content.width, h / content.height);
  return clampZoom(allowUpscale ? z : Math.min(1, z));
}

/** Human label, e.g. "67 %". */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)} %`;
}
