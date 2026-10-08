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
import { sniffImageType } from './images/dimensions.ts';
import type { UploadStore } from './storage/uploads.ts';

/**
 * Untrusted JSON -> canonical PlakatDocument (migrate + strict validation via
 * loadDocument, then derived-data normalization). Throws HttpError 400/422.
 */
export function parseIncomingDocument(input: unknown): PlakatDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'invalid_document', 'Expected a document object', { issues: [{ path: '(root)', message: 'Expected an object' }] });
  }
  try {
    return normalizeDocument(loadDocument(input));
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

/**
 * Moves embedded `data:` image assets into the upload store and rewrites their src to
 * `/uploads/<sha256>.<ext>` (keeps DB rows small, lets the editor load same-origin
 * files). An asset is only moved when its bytes sniff as its declared mimeType;
 * anything else is left untouched (it is still valid per the schema).
 */
export async function internalizeAssets<T extends Record<Id, Asset>>(assets: T, uploads: UploadStore): Promise<T> {
  const out: Record<Id, Asset> = {};
  for (const [id, asset] of Object.entries(assets)) {
    out[id] = asset;
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
  return out as T;
}

export async function internalizeDocumentAssets(doc: PlakatDocument, uploads: UploadStore): Promise<PlakatDocument> {
  return { ...doc, assets: await internalizeAssets(doc.assets, uploads) };
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
