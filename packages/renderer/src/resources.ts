import {
  collectFonts,
  compareDecodedSize,
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
 * Scale at which an SVG asset is rasterized (§3.2): its declared size times this factor.
 * Deterministic per asset (editor and export decode identically): up to 4x for crisp
 * print output, capped so the longest side stays within 4096 px, never below 1.
 */
export function svgRasterScale(asset: Pick<Asset, 'width' | 'height'>): number {
  return Math.max(1, Math.min(4, 4096 / Math.max(asset.width, asset.height)));
}

/** Pixel size an SVG asset is rasterized to (see svgRasterScale). */
export function svgRasterSize(asset: Pick<Asset, 'width' | 'height'>): { width: number; height: number } {
  const k = svgRasterScale(asset);
  return { width: Math.max(1, Math.round(asset.width * k)), height: Math.max(1, Math.round(asset.height * k)) };
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
  const imagesTask = Promise.all(
    assetIds.map(async (assetId) => {
      if (resources.images.has(assetId)) return;
      const asset = Object.hasOwn(doc.assets, assetId) ? doc.assets[assetId] : undefined;
      try {
        if (!asset) throw new AssetLoadError(assetId, `Image asset "${assetId}" is not in the document's asset registry`);
        const img = await env.loadImage(asset.src, asset, assetId);
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
