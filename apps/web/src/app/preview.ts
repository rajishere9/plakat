/**
 * Small PNG previews of pages through the real export path (@plakat/renderer
 * exportPage), used for project/template thumbnails and the pages panel. Renders run
 * one at a time so a gallery of previews cannot exhaust memory.
 */
import { exportPage, type ExportData, type RenderEnv } from '@plakat/renderer';
import type { Id, PlakatDocument } from '@plakat/schema';

/** Scale so the page's longest side becomes `maxSide` px (capped at 2x). */
export function previewScale(size: { width: number; height: number }, maxSide: number): number {
  const longest = Math.max(size.width, size.height, 1);
  return Math.max(0.01, Math.min(2, maxSide / longest));
}

export function toBlob(data: ExportData, mimeType: string): Blob {
  return data instanceof Blob ? data : new Blob([data as unknown as BlobPart], { type: mimeType });
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every previously queued preview render has settled. */
export function enqueueRender<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export interface PreviewOptions {
  /** Refuse to render with fallback fonts (thumbnails uploaded to the server). Default false. */
  strictFonts?: boolean;
}

/**
 * PNG of one page fitted into `maxSide` px. Rejects on missing assets / canvas errors;
 * fonts that fail to load fall back unless `strictFonts`.
 */
export function renderPagePreview(doc: PlakatDocument, pageId: Id, maxSide: number, env: RenderEnv, options: PreviewOptions = {}): Promise<Blob> {
  return enqueueRender(async () => {
    const data = await exportPage(doc, pageId, {
      format: 'png',
      scale: previewScale(doc.size, maxSide),
      env,
      allowFallbackFonts: !options.strictFonts,
    });
    return toBlob(data, 'image/png');
  });
}
