/**
 * The app-wide browser RenderEnv (one image cache and one font barrier per page) and the
 * project thumbnail producer.
 */
import { createBrowserEnv, exportPage, type RenderEnv } from '@plakat/renderer';
import type { PageSize, PlakatDocument } from '@plakat/schema';

let shared: RenderEnv | null = null;

/** The shared browser env (created lazily). Use it for exports too: images are cached by src. */
export function getRenderEnv(): RenderEnv {
  if (!shared) shared = createBrowserEnv();
  return shared;
}

/** Replace the shared env (tests, custom font CSS URLs). */
export function setRenderEnv(env: RenderEnv | null): void {
  shared = env;
}

/** Default longest side of a project thumbnail, in px. */
export const THUMBNAIL_MAX_SIDE = 480;

/** Export scale that fits a page into `maxSide` px (never upscales above 1x). */
export function thumbnailScale(size: Pick<PageSize, 'width' | 'height'>, maxSide = THUMBNAIL_MAX_SIDE): number {
  const longest = Math.max(size.width, size.height);
  if (!(longest > 0)) return 1;
  return Math.min(1, maxSide / longest);
}

export interface ThumbnailOptions {
  env?: RenderEnv;
  maxSide?: number;
  /** Page to render (default: the first page). */
  pageId?: string;
}

/**
 * PNG of page 1 (or `pageId`) scaled to fit `maxSide` (default 480 px), through the real
 * export path (`exportPage`, with fallback fonts allowed). Resolves null when the page
 * cannot be rendered (e.g. an image asset failed to load).
 */
export async function renderThumbnail(doc: PlakatDocument, opts: ThumbnailOptions = {}): Promise<Blob | null> {
  const page = opts.pageId ? doc.pages.find((p) => p.id === opts.pageId) : doc.pages[0];
  if (!page) return null;
  try {
    const data = await exportPage(doc, page.id, {
      format: 'png',
      scale: thumbnailScale(doc.size, opts.maxSide),
      env: opts.env ?? getRenderEnv(),
      allowFallbackFonts: true,
    });
    return data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  } catch (err) {
    console.warn('[plakat] thumbnail rendering failed:', err);
    return null;
  }
}

/**
 * A producer for `persistence.setThumbnailProducer(...)`:
 *   persistence.setThumbnailProducer(createThumbnailProducer());
 */
export function createThumbnailProducer(opts: ThumbnailOptions = {}): (doc: PlakatDocument) => Promise<Blob | null> {
  return (doc) => renderThumbnail(doc, opts);
}
