import { HttpError } from '../errors.ts';
import { fetchPublic, readBodyCapped, type HostResolver } from '../net/safeFetch.ts';
import type { StoredUpload, UploadStore } from '../storage/uploads.ts';

export const ALLOWED_IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

export const USER_AGENT = 'Plakat/0.1 (self-hosted design editor)';

export interface DownloadOptions {
  fetch: typeof fetch;
  resolveHost: HostResolver;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Downloads an image over http(s) with the SSRF guard (public addresses only, every
 * redirect hop checked), a timeout, an image content-type check and a size cap.
 * Throws HttpError 413/502/504; the bytes are NOT sniffed yet (UploadStore.store does).
 */
export async function downloadPublicImage(url: string, options: DownloadOptions): Promise<Uint8Array> {
  const { response } = await fetchPublic(url, {
    fetch: options.fetch,
    resolveHost: options.resolveHost,
    timeoutMs: options.timeoutMs,
    headers: { Accept: 'image/*', 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(502, 'upstream_error', `Image download failed with HTTP ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(502, 'bad_upstream_content', `Remote server returned unsupported content type "${contentType || 'none'}"`);
  }
  return readBodyCapped(response, options.maxBytes);
}

/**
 * Imports remote (`http(s)://`) asset srcs of incoming documents into the upload
 * store, so that viewers' browsers never contact third-party hosts and the canvas
 * stays CORS-clean (document-schema.md §8, pipeline P-4). Successful downloads are
 * cached by URL (bounded) because clients re-send the same document on every autosave.
 */
export class RemoteAssetImporter {
  private readonly cache = new Map<string, StoredUpload>();

  constructor(
    private readonly uploads: UploadStore,
    private readonly options: Omit<DownloadOptions, 'maxBytes'> & { cacheSize?: number },
  ) {}

  /** Downloads + stores `url`; throws HttpError (see downloadPublicImage / UploadStore.store). */
  async import(url: string): Promise<StoredUpload> {
    const hit = this.cache.get(url);
    if (hit) {
      // Refresh LRU position.
      this.cache.delete(url);
      this.cache.set(url, hit);
      return hit;
    }
    const bytes = await downloadPublicImage(url, { ...this.options, maxBytes: this.uploads.maxBytes });
    const stored = await this.uploads.store(bytes, { filename: url.slice(0, 255) });
    this.cache.set(url, stored);
    const max = this.options.cacheSize ?? 1000;
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value!);
    return stored;
  }

  isCached(url: string): boolean {
    return this.cache.has(url);
  }
}
