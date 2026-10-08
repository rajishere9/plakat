/**
 * @plakat/renderer — the one scene builder and raster/export pipeline shared by the
 * editor and exports (docs/render-export-pipeline.md). Safe to import in browsers and
 * Node (no DOM access at import time). Under Node, import `@plakat/renderer/node`
 * (createNodeEnv) first: it installs Konva's node-canvas backend.
 */
export type { DecodedImage, ExportData, LoadImageOptions, RenderCanvas, RenderEnv, Resources } from './types.ts';
export { createEmptyResources } from './types.ts';
export { AssetLoadError, CanvasLimitError, FontLoadError, RasterError } from './errors.ts';
export {
  ASSET_PLACEHOLDER_NAME,
  ELEMENT_HITBOX_NAME,
  ELEMENT_NODE_NAME,
  IMAGE_FLIP_NAME,
  PAGE_BACKGROUND_IMAGE_NAME,
  PAGE_BACKGROUND_NAME,
  PAGE_CONTENT_NAME,
  PAGE_ROOT_NAME,
  PageScene,
  applyElement,
  createElementNode,
  type ApplyContext,
  type PageSceneOptions,
  type PageSceneUpdateOptions,
} from './scene.ts';
export { rasterizePage } from './rasterize.ts';
export {
  SVG_RASTER_MAX_AREA,
  SVG_RASTER_MAX_SIDE,
  SVG_RASTER_PIXEL_RATIO,
  decodedSvgScale,
  prepareResources,
  resourcesOutdated,
  svgDisplayScales,
  svgRasterScale,
  svgRasterSize,
  type PrepareResourcesOptions,
} from './resources.ts';
export {
  DEFAULT_JPEG_QUALITY,
  MIME_TYPES,
  assertCanvasFits,
  exportDocument,
  exportPage,
  flattenOntoWhite,
  renderPageCanvas,
  renderPageWithResources,
  type ExportDocumentOptions,
  type ExportFormat,
  type ExportPageOptions,
  type ExportResult,
  type RenderPageOptions,
  type RenderedPage,
} from './export.ts';
export {
  applyFilterAttrs,
  cacheFilteredNode,
  FILTER_CACHE_MAX_AREA,
  filterCacheOffset,
  planFilterCache,
  platformCanvasLimits,
  type FilterCacheOptions,
  type FilterCacheOverflow,
  type FilterCachePlan,
  hasActiveFilters,
  konvaFilterList,
  konvaSaturation,
  syncFilterCache,
} from './filters.ts';
export { containsRtl, invalidateTextMeasurements, textBaseDirection, textLayoutAttrs, widestGraphemeWidth, type TextLayoutAttrs } from './text.ts';
export { createZip, crc32, readStoredZip, type ZipEntry } from './zip.ts';
export { dpiToPixelsPerMetre, encodeCanvasDefault, readJpegDensity, readPngPhys, setJpegDpi, setPngDpi } from './encode.ts';
export { exportBaseName, pageFileName, pageNumberLabel, slugify } from './filename.ts';
export { canonicalFontCssUrl, createBrowserEnv, isWebKitBrowser, loadFontStylesheet, type BrowserEnvOptions } from './env-browser.ts';
export {
  PAGE_FRAME_NAME,
  createPageFrame,
  editorPixelRatio,
  getElementIdFromNode,
  getElementNodeFromNode,
  getPageIdFromNode,
  mountPageScene,
} from './editor.ts';
export { Konva } from './konva.ts';
