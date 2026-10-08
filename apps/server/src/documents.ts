import {
  bundleAssets,
  dataUriToBytes,
  isDataUri,
  loadDocument,
  normalizeDocument,
  type Asset,
  type Id,
  type PlakatDocument,
} from '@plakat/schema';
import { HttpError, schemaErrorToHttp } from './errors.ts';
import type { RemoteAssetImporter } from './assets/remote.ts';
import { sniffImageType } from './images/dimensions.ts';
import type { UploadStore } from './storage/uploads.ts';

/** Max asset registry entries per document / brand kit accepted by the server. */
export const MAX_ASSETS_PER_DOCUMENT = 1000;
/** Max remote (http/https) srcs downloaded for one request (cached URLs don't count). */
export const MAX_REMOTE_FETCHES_PER_REQUEST = 50;
const REMOTE_FETCH_CONCURRENCY = 4;

/** NUL, or a UTF-16 surrogate code unit without its partner (matched per code unit: no `u` flag). */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNSTORABLE_G = new RegExp(UNSTORABLE.source, 'g');

function cleanString(s: string): string {
  if (!UNSTORABLE.test(s)) return s;
  return s.replace(UNSTORABLE_G, (c) => (c === '\u0000' ? '' : '\uFFFD'));
}

/**
 * Deep-copies parsed JSON, removing U+0000 and replacing unpaired UTF-16 surrogates
 * (U+FFFD) in every string and key. PostgreSQL text/jsonb cannot store either, so
 * without this a stray NUL in pasted text made every save fail with a 500.
 */
export function sanitizeJsonStrings(value: unknown): unknown {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanString(k), sanitizeJsonStrings(v)]));
  }
  return value;
}

/** Strips characters PostgreSQL cannot store from a query-string value. */
export function cleanQueryString(s: string): string {
  return cleanString(s);
}

/**
 * Untrusted JSON -> canonical PlakatDocument (migrate + strict validation via
 * loadDocument, then derived-data normalization). Throws HttpError 400/422.
 */
export function parseIncomingDocument(input: unknown): PlakatDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'invalid_document', 'Expected a document object', { issues: [{ path: '(root)', message: 'Expected an object' }] });
  }
  try {
    return normalizeDocument(loadDocument(sanitizeJsonStrings(input)));
  } catch (error) {
    throw schemaErrorToHttp(error) ?? error;
  }
}

/** Reads a stored document (migrating older schemaVersions on read). */
export function loadStoredDocument(json: unknown): PlakatDocument {
  return loadDocument(json);
}

export function withUpdatedAt(doc: PlakatDocument, now: Date): PlakatDocument {
  return { ...doc, meta: { ...doc.meta, updatedAt: now.toISOString() } };
}

const isRemoteSrc = (src: string) => /^https?:\/\//i.test(src);

export interface InternalizeOptions {
  /**
   * Downloads http(s) srcs into uploads (request paths). When absent (built-in
   * template seeding at startup) remote srcs are left untouched.
   */
  remote?: RemoteAssetImporter | null;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Moves embedded `data:` image assets into the upload store and rewrites their src to
 * `/uploads/<sha256>.<ext>` (keeps DB rows small, lets the editor load same-origin
 * files). An asset is only moved when its bytes sniff as its declared mimeType;
 * anything else is left untouched (it is still valid per the schema).
 *
 * With `options.remote`, `http(s)://` srcs are downloaded (SSRF-guarded) into uploads
 * too; one that cannot be fetched, or is not the declared image type, fails the
 * request with 422 `asset_fetch_failed` naming the asset.
 *
 * At most MAX_ASSETS_PER_DOCUMENT entries are accepted (each distinct data: asset
 * becomes a file plus a DB row, so an uncapped registry is a file-count amplifier).
 */
export async function internalizeAssets<T extends Record<Id, Asset>>(assets: T, uploads: UploadStore, options: InternalizeOptions = {}): Promise<T> {
  const entries = Object.entries(assets);
  if (entries.length > MAX_ASSETS_PER_DOCUMENT) {
    throw new HttpError(413, 'too_many_assets', `Too many assets (${entries.length} > ${MAX_ASSETS_PER_DOCUMENT})`, {
      limit: MAX_ASSETS_PER_DOCUMENT,
    });
  }
  const out: Record<Id, Asset> = {};
  const remote: [Id, Asset][] = [];
  for (const [id, asset] of entries) {
    out[id] = asset;
    if (options.remote && isRemoteSrc(asset.src)) {
      remote.push([id, asset]);
      continue;
    }
    if (!isDataUri(asset.src)) continue;
    let bytes: Uint8Array;
    try {
      bytes = dataUriToBytes(asset.src).bytes;
    } catch {
      continue;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > uploads.maxBytes || sniffImageType(bytes) !== asset.mimeType) continue;
    try {
      const stored = await uploads.store(bytes, { filename: asset.name || id });
      out[id] = { ...asset, src: stored.src };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  const importer = options.remote;
  if (importer && remote.length) {
    const uncached = new Set(remote.map(([, a]) => a.src).filter((src) => !importer.isCached(src)));
    if (uncached.size > MAX_REMOTE_FETCHES_PER_REQUEST) {
      throw new HttpError(422, 'too_many_remote_assets', `Too many remote images to download (${uncached.size} > ${MAX_REMOTE_FETCHES_PER_REQUEST}); embed them as data: URIs`, {
        limit: MAX_REMOTE_FETCHES_PER_REQUEST,
      });
    }
    await mapLimit(remote, REMOTE_FETCH_CONCURRENCY, async ([id, asset]) => {
      let stored;
      try {
        stored = await importer.import(asset.src);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        throw new HttpError(422, 'asset_fetch_failed', `Asset "${id}" (${asset.src.slice(0, 200)}) could not be downloaded: ${error.message}`, {
          assetId: id,
        });
      }
      if (stored.mimeType !== asset.mimeType) {
        throw new HttpError(422, 'asset_fetch_failed', `Asset "${id}" (${asset.src.slice(0, 200)}) is ${stored.mimeType}, but the document declares ${asset.mimeType}`, {
          assetId: id,
        });
      }
      out[id] = { ...asset, src: stored.src };
    });
  }
  return out as T;
}

export async function internalizeDocumentAssets(doc: PlakatDocument, uploads: UploadStore, options: InternalizeOptions = {}): Promise<PlakatDocument> {
  return { ...doc, assets: await internalizeAssets(doc.assets, uploads, options) };
}

/**
 * Portable export: every asset becomes a data: URI. Only this server's own uploads
 * are read (from disk); remote or other root-relative srcs are never fetched
 * server-side (SSRF) and make the export fail with 422.
 */
export async function bundleDocumentForExport(doc: PlakatDocument, uploads: UploadStore): Promise<PlakatDocument> {
  return bundleAssets(doc, async (src, assetId) => {
    const bytes = await uploads.readBySrc(src);
    if (!bytes) {
      throw new HttpError(422, 'asset_not_bundlable', `Asset "${assetId}" (${src.slice(0, 200)}) cannot be embedded: only this server's uploads can be bundled`, {
        assetId,
      });
    }
    return { bytes };
  });
}

/** Columns derived from a document for list views. */
export function documentSummary(doc: PlakatDocument) {
  return {
    title: doc.meta.title,
    size: doc.size,
    pageCount: doc.pages.length,
    schemaVersion: doc.schemaVersion,
    category: doc.template?.category ?? null,
    slotCount: doc.template?.slots.length ?? 0,
    searchText: [doc.meta.title, doc.template?.category ?? '', doc.meta.description, ...doc.meta.tags].join('\n').toLowerCase(),
  };
}

/** Escapes LIKE/ILIKE wildcards for use with `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `My design!` -> `my-design` (download file names). */
export function slugify(s: string): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'plakat';
}
