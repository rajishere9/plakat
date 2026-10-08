/**
 * Template gallery previews. Uses the server thumbnail when there is one; otherwise
 * fetches the template, renders its first page with @plakat/renderer (exportPage) and,
 * when every font loaded, uploads the result as a user template's thumbnail so the next
 * visitor gets it for free (best effort; errors are ignored). Built-in templates' thumbnails
 * cannot be set by clients (403), so their previews are rendered once per session.
 */
import type { TemplateSummary } from '../api/index.ts';
import type { AppServices } from './services.tsx';

const PREVIEW_MAX_SIDE = 400;
const cache = new Map<string, Promise<string | null>>();

function cacheKey(t: Pick<TemplateSummary, 'id'> & { updatedAt?: unknown }): string {
  return `${t.id}@${typeof t.updatedAt === 'string' ? t.updatedAt : ''}`;
}

/** Object URL (or server URL) of a template preview, or null when it cannot be rendered. */
export function templatePreviewUrl(summary: TemplateSummary, services: Pick<AppServices, 'api' | 'renderPreview'>): Promise<string | null> {
  if (summary.thumbnailUrl) return Promise.resolve(summary.thumbnailUrl);
  const key = cacheKey(summary as TemplateSummary & { updatedAt?: unknown });
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const { document } = await services.api.getTemplate(summary.id);
        const page = document.pages[0];
        if (!page) return null;
        let blob: Blob;
        let strict = true;
        try {
          blob = await services.renderPreview(document, page.id, PREVIEW_MAX_SIDE, { strictFonts: true });
        } catch {
          strict = false;
          blob = await services.renderPreview(document, page.id, PREVIEW_MAX_SIDE);
        }
        // Built-in thumbnails are read-only on the server (403): render them per session.
        if (strict && !summary.builtIn) void services.api.uploadTemplateThumbnail(summary.id, blob).catch(() => undefined);
        return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
      } catch {
        cache.delete(key);
        return null;
      }
    })();
    cache.set(key, p);
  }
  return p;
}

export function clearTemplatePreviewCache(): void {
  cache.clear();
}
