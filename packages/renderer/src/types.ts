import type { Asset, CanvasLimits, FontLoadRequest, FontRef, Id } from '@plakat/schema';

/**
 * A decoded, drawable image: an HTMLImageElement / ImageBitmap / canvas in browsers,
 * a node-canvas Image or Canvas under Node. `width`/`height` are the DECODED pixel
 * size (which may differ from the asset's declared size, schema D-19).
 */
export type DecodedImage = CanvasImageSource & { readonly width: number; readonly height: number };

/** Any canvas the renderer produces: HTMLCanvasElement in browsers, node-canvas `Canvas` under Node. */
export type RenderCanvas = HTMLCanvasElement;

/** Encoded file bytes as handed to callers: a Blob in browsers, a Buffer (Uint8Array) under Node. */
export type ExportData = Blob | Uint8Array;

/**
 * Platform services the renderer needs (render-export-pipeline.md §1.1).
 * Use `createBrowserEnv()` (index) or `createNodeEnv()` (`@plakat/renderer/node`).
 */
export interface RenderEnv {
  /** Platform id, informational. */
  readonly kind: 'browser' | 'node' | (string & {});
  /**
   * Decode `src` (already validated by the schema) into a drawable image. SVGs must be
   * rasterized to a canvas of exactly `svgRasterSize(asset, opts.svgRasterScale)` px
   * (prepareResources passes the scale the document needs; default svgRasterScale(asset)).
   * Rejects with AssetLoadError. Implementations cache by src (SVGs by src + raster size).
   */
  loadImage(src: string, asset: Asset, assetId: Id, opts?: LoadImageOptions): Promise<DecodedImage>;
  /**
   * The font readiness barrier (§3.1). Resolves only when every request is drawable
   * with the real font; otherwise rejects with FontLoadError listing missing variants.
   * `fonts` = collectFonts() over the rendered pages, `requests` = fontLoadRequests().
   */
  loadFonts(fonts: FontRef[], requests: FontLoadRequest[]): Promise<void>;
  /** Encode a canvas. Default (when omitted): auto-detect toBuffer (Node) / toBlob (browser). */
  encodeCanvas?(canvas: RenderCanvas, mimeType: 'image/png' | 'image/jpeg', quality?: number): Promise<Uint8Array>;
  /** Wrap final bytes for the caller (browser: Blob; Node: Buffer). Default: the bytes as-is. */
  wrapOutput?(bytes: Uint8Array, mimeType: string): ExportData;
  /** Canvas size limits for the pre-allocation check (§4). Default: DEFAULT_CANVAS_LIMITS (browser env: Safari limits on WebKit). */
  canvasLimits?(): CanvasLimits;
  /** A detached container element for offscreen Konva stages (browser only). */
  createStageContainer?(): HTMLDivElement | undefined;
}

export interface LoadImageOptions {
  /** SVG only: rasterize at the declared size times this factor (svgRasterScale). */
  svgRasterScale?: number;
}

/** Output of the readiness barrier: everything a PageScene needs to draw synchronously. */
export interface Resources {
  /** Decoded images by asset id (only successfully decoded ones). */
  images: Map<Id, DecodedImage>;
  /** Assets that failed to load (only when `allowMissingAssets`); drawn as a checkerboard placeholder. */
  missingAssets: Id[];
  /** Human-readable missing font variants (only when `allowFallbackFonts`). */
  missingFonts: string[];
}

export function createEmptyResources(): Resources {
  return { images: new Map(), missingAssets: [], missingFonts: [] };
}
