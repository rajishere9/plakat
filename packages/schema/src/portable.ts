import { normalizeDocument } from './factory.ts';
import { assertValidDocument, DocumentValidationError, loadDocument } from './load.ts';
import type { Asset, Id, PlakatDocument } from './types.ts';
import type { MigrateOptions } from './version.ts';

export const PORTABLE_FILE_EXTENSION = '.plakat.json';
export const PORTABLE_MIME_TYPE = 'application/vnd.plakat+json';

export interface SerializeOptions {
  /** 2-space indentation (default true). */
  pretty?: boolean;
}

/**
 * Serializes a document to the `.plakat.json` text form. Normalizes derived data
 * (fonts cache) and validates first — invalid documents are never written.
 */
export function serializeDocument(doc: PlakatDocument, options: SerializeOptions = {}): string {
  const normalized = normalizeDocument(doc);
  assertValidDocument(normalized);
  return JSON.stringify(normalized, null, options.pretty === false ? undefined : 2) + '\n';
}

/** Parses `.plakat.json` text: JSON.parse -> migrate -> strict validation. */
export function parseDocument(text: string, options?: MigrateOptions): PlakatDocument {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DocumentValidationError([
      { path: '(root)', message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` },
    ]);
  }
  return loadDocument(json, options);
}

// ---------------------------------------------------------------------------
// Asset bundling
// ---------------------------------------------------------------------------

export interface FetchedAsset {
  bytes: Uint8Array;
}

/** Resolves a non-data src to bytes. Injected so browser, server and tests can differ. */
export type AssetFetcher = (src: string, assetId: Id, asset: Asset) => Promise<FetchedAsset>;

export function isDataUri(src: string): boolean {
  return src.startsWith('data:');
}

/** True when every asset is embedded, i.e. the file renders with no network access except Google Fonts. */
export function isPortable(doc: Pick<PlakatDocument, 'assets'>): boolean {
  return Object.values(doc.assets).every((a) => isDataUri(a.src));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

/** Decodes a base64 or percent-encoded data: URI. */
export function dataUriToBytes(uri: string): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(uri);
  if (!match) throw new Error('Not a data: URI');
  const mimeType = match[1] || 'text/plain';
  const isBase64 = /;base64$/i.test(match[2] ?? '');
  const payload = match[3] ?? '';
  const bytes = isBase64 ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
  return { mimeType, bytes };
}

/** Returns a copy of the document with every asset src rewritten by `fn` (sync or async). */
export async function mapAssetSources(
  doc: PlakatDocument,
  fn: (asset: Asset, assetId: Id) => string | Promise<string>,
): Promise<PlakatDocument> {
  const entries = await Promise.all(
    Object.entries(doc.assets).map(async ([id, asset]) => [id, { ...asset, src: await fn(asset, id) }] as const),
  );
  return { ...doc, assets: Object.fromEntries(entries) };
}

/**
 * "Export as file": embeds every non-data asset as a base64 data: URI so the
 * `.plakat.json` is self-contained. Fetches run concurrently; any failure rejects.
 */
export async function bundleAssets(doc: PlakatDocument, fetchAsset: AssetFetcher = defaultFetchAsset): Promise<PlakatDocument> {
  return mapAssetSources(doc, async (asset, id) => {
    if (isDataUri(asset.src)) return asset.src;
    const fetched = await fetchAsset(asset.src, id, asset);
    // The declared (validated) mimeType wins over whatever the server sent.
    return bytesToDataUri(fetched.bytes, asset.mimeType);
  });
}

export interface FetchAssetFetcherOptions {
  /**
   * Whether absolute http(s) srcs may be fetched (default true, fine in a browser
   * where CORS applies). SERVER-SIDE callers must pass `false` or an allow-list
   * predicate: srcs come from untrusted files, so an open fetcher is an SSRF vector.
   * (The Plakat server never bundles remote srcs: it downloads them into its uploads,
   * SSRF-guarded, when a document is written.)
   */
  allowRemote?: boolean | ((url: URL) => boolean);
}

/**
 * Fetcher using global fetch(). Root-relative srcs resolve against `baseUrl` (default
 * `location.href`) and must stay on that origin; schemes other than http(s) are refused.
 */
export function createFetchAssetFetcher(baseUrl?: string, options: FetchAssetFetcherOptions = {}): AssetFetcher {
  return async (src) => {
    const url = resolveAssetUrl(src, baseUrl ?? (typeof location !== 'undefined' ? location.href : undefined), options);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch asset ${src}: HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()) };
  };
}

/**
 * Resolves a non-data asset src to the URL to fetch, enforcing: root-relative srcs
 * stay on the base origin (rejects `/\\host`-style tricks even if a src bypassed
 * validation), only http(s), and the `allowRemote` policy for absolute URLs.
 */
export function resolveAssetUrl(src: string, baseUrl: string | undefined, options: FetchAssetFetcherOptions = {}): URL {
  if (src.startsWith('/')) {
    if (!baseUrl) throw new Error(`Root-relative asset src ${src} needs a baseUrl`);
    const base = new URL(baseUrl);
    const url = new URL(src, base);
    if (url.origin !== base.origin || /[\\\s]/.test(src) || src.startsWith('//')) {
      throw new Error(`Asset src ${src} escapes the server origin`);
    }
    return url;
  }
  const url = new URL(src);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported asset URL scheme in ${src}`);
  const allow = options.allowRemote ?? true;
  if (allow === false || (typeof allow === 'function' && !allow(url))) throw new Error(`Remote asset ${src} is not allowed here`);
  return url;
}

export const defaultFetchAsset: AssetFetcher = (src, id, asset) => createFetchAssetFetcher()(src, id, asset);
