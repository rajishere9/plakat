import {
  collectFonts,
  compareDecodedSize,
  computeImageLayout,
  fontLoadRequests,
  referencedAssetIds,
  type Asset,
  type Id,
  type PlakatDocument,
} from '@plakat/schema';
import { AssetLoadError, FontLoadError } from './errors.ts';
import { invalidateTextMeasurements } from './text.ts';
import { createEmptyResources, type RenderEnv, type Resources } from './types.ts';

export interface PrepareResourcesOptions {
  /**
   * Editor: render with fallback fonts instead of rejecting (missing variants are listed in
   * `resources.missingFonts`). Export refuses by default (§3.1).
   */
  allowFallbackFonts?: boolean;
  /** Editor: record failed assets in `resources.missingAssets` (drawn as placeholders) instead of rejecting. */
  allowMissingAssets?: boolean;
  /** Add to an existing Resources object (already-decoded assets are skipped) instead of a new one. */
  into?: Resources;
  /** Warn sink for decoded-vs-declared aspect mismatches (default console.warn). */
  warn?: (message: string) => void;
}

/**
 * Output pixel ratio SVG rasters are made for (§3.2): at least print (3.125), and enough
 * for a 2× screen at 2× zoom. The raster depends on the DOCUMENT only (asset + element
 * sizes), never on the current zoom or export scale, so the editor and every export of
 * the same document draw the same bitmap (byte parity).
 */
export const SVG_RASTER_PIXEL_RATIO = 4;
/** SVG raster caps, identical on every platform (Safari's canvas area) for parity. */
export const SVG_RASTER_MAX_SIDE = 8192;
export const SVG_RASTER_MAX_AREA = 16_777_216;

/**
 * Scale at which an SVG asset is rasterized: its declared size times this factor.
 * `displayScale` is the largest number of document px one declared SVG px covers in the
 * document (svgDisplayScales; an icon declared 24×24 drawn at 600×600 → 25). The factor is
 * displayScale (at least 1) × SVG_RASTER_PIXEL_RATIO, rounded UP to a half-octave step
 * (so small resizes do not re-rasterize), capped at SVG_RASTER_MAX_SIDE per side and
 * SVG_RASTER_MAX_AREA in total.
 */
export function svgRasterScale(asset: Pick<Asset, 'width' | 'height'>, displayScale = 1): number {
  const wanted = Math.max(1, Number.isFinite(displayScale) ? displayScale : 1) * SVG_RASTER_PIXEL_RATIO;
  const stepped = 2 ** (Math.ceil(Math.log2(wanted) * 2 - 1e-9) / 2);
  const cap = Math.min(SVG_RASTER_MAX_SIDE / Math.max(asset.width, asset.height), Math.sqrt(SVG_RASTER_MAX_AREA / (asset.width * asset.height)));
  return Math.min(stepped, cap);
}

/** Pixel size an SVG asset is rasterized to (see svgRasterScale). */
export function svgRasterSize(asset: Pick<Asset, 'width' | 'height'>, scale: number = svgRasterScale(asset)): { width: number; height: number } {
  return { width: Math.max(1, Math.round(asset.width * scale)), height: Math.max(1, Math.round(asset.height * scale)) };
}

function isSvg(asset: Asset | undefined): asset is Asset {
  return asset?.mimeType === 'image/svg+xml';
}

/**
 * Per SVG asset: the largest number of document px that one declared SVG px covers,
 * over EVERY use in the document (all pages, hidden elements and page backgrounds
 * included), so the raster does not depend on which pages are being rendered.
 */
export function svgDisplayScales(doc: Pick<PlakatDocument, 'pages' | 'assets' | 'size'>): Map<Id, number> {
  const out = new Map<Id, number>();
  const note = (assetId: Id, box: Parameters<typeof computeImageLayout>[0]) => {
    const asset = Object.hasOwn(doc.assets, assetId) ? doc.assets[assetId] : undefined;
    if (!isSvg(asset)) return;
    const { crop, dest } = computeImageLayout(box, asset);
    const k = Math.max(crop.width > 0 ? dest.width / crop.width : 0, crop.height > 0 ? dest.height / crop.height : 0);
    if (Number.isFinite(k)) out.set(assetId, Math.max(out.get(assetId) ?? 0, k));
  };
  for (const page of doc.pages) {
    const bg = page.background.image;
    if (bg) note(bg.assetId, { width: doc.size.width, height: doc.size.height, crop: null, objectFit: 'cover' });
    for (const el of page.elements) if (el.type === 'image') note(el.assetId, el);
  }
  return out;
}

/** Raster scale each decoded SVG bitmap was made at (set by prepareResources). */
const svgScaleOfImage = new WeakMap<object, number>();

/** The svgRasterScale a decoded image was rasterized at, or undefined (bitmaps, unknown). */
export function decodedSvgScale(img: object): number | undefined {
  return svgScaleOfImage.get(img);
}

/**
 * True when `resources` cannot draw the given pages of `doc` as a fresh prepareResources
 * would: an asset is neither decoded nor recorded missing, or an SVG was rasterized at
 * another scale than the document now needs (an element using it was resized). The
 * editor calls this after document changes and runs prepareResources({ into }) when true.
 */
export function resourcesOutdated(doc: PlakatDocument, resources: Resources, pageIds?: readonly Id[]): boolean {
  const pages = pageIds ? doc.pages.filter((p) => pageIds.includes(p.id)) : doc.pages;
  let scales: Map<Id, number> | undefined;
  for (const assetId of referencedAssetIds({ pages })) {
    const img = resources.images.get(assetId);
    if (!img) {
      if (!resources.missingAssets.includes(assetId)) return true;
      continue;
    }
    const asset = Object.hasOwn(doc.assets, assetId) ? doc.assets[assetId] : undefined;
    if (!isSvg(asset)) continue;
    scales ??= svgDisplayScales(doc);
    if (decodedSvgScale(img) !== svgRasterScale(asset, scales.get(assetId) ?? 1)) return true;
  }
  return false;
}

/**
 * The readiness barrier (§3): resolves only when every font and image used by the given
 * pages is drawable. Fonts are derived from the elements (collectFonts / fontLoadRequests),
 * never from `doc.fonts`. Hidden elements are included (unhiding must not need a load).
 */
export async function prepareResources(
  doc: PlakatDocument,
  pageIds: readonly Id[] | undefined,
  env: RenderEnv,
  opts: PrepareResourcesOptions = {},
): Promise<Resources> {
  const resources = opts.into ?? createEmptyResources();
  const ids = pageIds ?? doc.pages.map((p) => p.id);
  const idSet = new Set(ids);
  const pages = doc.pages.filter((p) => idSet.has(p.id));
  for (const id of ids) {
    if (!pages.some((p) => p.id === id)) throw new Error(`Page "${id}" is not in the document`);
  }

  const fontsTask = (async () => {
    const fonts = collectFonts({ pages, fonts: doc.fonts });
    if (fonts.length === 0) return;
    try {
      await env.loadFonts(fonts, fontLoadRequests(doc, { pageIds: ids }));
    } catch (err) {
      if (!opts.allowFallbackFonts) throw err;
      const missing = err instanceof FontLoadError ? err.missing : [String(err)];
      for (const m of missing) if (!resources.missingFonts.includes(m)) resources.missingFonts.push(m);
    } finally {
      // Any measurement taken before this point may have used a fallback font.
      invalidateTextMeasurements();
    }
  })();

  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const assetIds = [...referencedAssetIds({ pages })];
  const svgScales = assetIds.some((id) => isSvg(Object.hasOwn(doc.assets, id) ? doc.assets[id] : undefined)) ? svgDisplayScales(doc) : null;
  const imagesTask = Promise.all(
    assetIds.map(async (assetId) => {
      const asset = Object.hasOwn(doc.assets, assetId) ? doc.assets[assetId] : undefined;
      // SVGs are rasterized for how large the document draws them (§3.2).
      const svgScale = isSvg(asset) ? svgRasterScale(asset, svgScales?.get(assetId) ?? 1) : undefined;
      const existing = resources.images.get(assetId);
      if (existing && (svgScale === undefined || decodedSvgScale(existing) === svgScale)) return;
      try {
        if (!asset) throw new AssetLoadError(assetId, `Image asset "${assetId}" is not in the document's asset registry`);
        const img = await env.loadImage(asset.src, asset, assetId, svgScale === undefined ? undefined : { svgRasterScale: svgScale });
        if (svgScale !== undefined) svgScaleOfImage.set(img, svgScale);
        if (!(img.width > 0 && img.height > 0)) throw new AssetLoadError(assetId, `Image asset "${assetId}" decoded to an empty bitmap`);
        if (compareDecodedSize(asset, img).aspectMismatch) {
          warn(
            `[plakat] Asset "${assetId}" decodes to ${img.width}x${img.height} but is declared ${asset.width}x${asset.height} (aspect mismatch; un-baked EXIF orientation?)`,
          );
        }
        resources.images.set(assetId, img);
        const i = resources.missingAssets.indexOf(assetId);
        if (i >= 0) resources.missingAssets.splice(i, 1);
      } catch (err) {
        const e = err instanceof AssetLoadError ? err : new AssetLoadError(assetId, undefined, { cause: err });
        if (!opts.allowMissingAssets) throw e;
        if (!resources.missingAssets.includes(assetId)) resources.missingAssets.push(assetId);
      }
    }),
  );

  const [f, i] = await Promise.allSettled([fontsTask, imagesTask]);
  if (f.status === 'rejected') throw f.reason;
  if (i.status === 'rejected') throw i.reason;
  return resources;
}
