import { HttpError } from '../errors.ts';
import type { AssetProvider, ProviderDownload, ProviderItem, ProviderSearchOptions, ProviderSearchResult } from './provider.ts';

export interface OpenverseOptions {
  /** Default https://api.openverse.org */
  apiBase?: string;
  clientId?: string | null;
  clientSecret?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Clock override for token expiry (tests). */
  now?: () => number;
}

/** Subset of the Openverse v1 image object we use. */
interface OpenverseImage {
  id: string;
  title?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  width?: number | null;
  height?: number | null;
  creator?: string | null;
  creator_url?: string | null;
  license?: string | null;
  license_version?: string | null;
  license_url?: string | null;
  foreign_landing_url?: string | null;
}

interface OpenverseSearchResponse {
  result_count?: number;
  page_count?: number;
  page?: number;
  results?: OpenverseImage[];
}

const ITEM_ID = /^[A-Za-z0-9-]{1,64}$/;
const USER_AGENT = 'Plakat/0.1 (self-hosted design editor; https://github.com/plakat)';
/** Anonymous Openverse requests: page_size <= 20 and at most 240 results deep. */
const ANON_MAX_PAGE_SIZE = 20;
const AUTH_MAX_PAGE_SIZE = 50;
const ANON_MAX_RESULTS = 240;

const httpUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\/[^\s\\]+$/i.test(v) ? v : null);
const text = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const dim = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

/** "by-sa" + "2.0" -> "CC BY-SA 2.0"; "cc0" -> "CC0 1.0"; "pdm" -> "Public Domain Mark 1.0". */
export function openverseLicenseLabel(license: string | null | undefined, version: string | null | undefined): string | null {
  if (!license) return null;
  const code = license.toLowerCase();
  const base = code === 'cc0' ? 'CC0' : code === 'pdm' ? 'Public Domain Mark' : `CC ${code.toUpperCase()}`;
  return version ? `${base} ${version}` : base;
}

export function mapOpenverseImage(img: OpenverseImage): ProviderItem {
  return {
    id: String(img.id),
    title: text(img.title) ?? 'Untitled',
    thumbUrl: httpUrl(img.thumbnail),
    previewUrl: httpUrl(img.url),
    width: dim(img.width),
    height: dim(img.height),
    creator: text(img.creator),
    creatorUrl: httpUrl(img.creator_url),
    license: openverseLicenseLabel(img.license, img.license_version),
    licenseUrl: httpUrl(img.license_url),
    pageUrl: httpUrl(img.foreign_landing_url),
  };
}

/**
 * Openverse (https://openverse.org) — openly licensed images, API v1. Works
 * anonymously (lower rate limits); with OPENVERSE_CLIENT_ID/SECRET it obtains and
 * caches an OAuth client-credentials token.
 */
export class OpenverseProvider implements AssetProvider {
  readonly id = 'openverse';
  readonly name = 'Openverse';
  readonly description = 'Millions of openly licensed images (Creative Commons and public domain) from Flickr, Wikimedia and more.';
  readonly requiresKey = false;
  readonly homepage = 'https://openverse.org';
  readonly licenseNote =
    'Images carry their own Creative Commons or public-domain licenses. Check each license (some forbid commercial use or modifications) and keep the attribution.';

  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: OpenverseOptions = {}) {
    this.apiBase = (options.apiBase ?? 'https://api.openverse.org').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  private get hasCredentials(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret);
  }

  isConfigured(): boolean {
    return true;
  }

  private async getToken(): Promise<string | null> {
    if (!this.hasCredentials) return null;
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    try {
      const res = await this.fetchImpl(`${this.apiBase}/v1/auth_tokens/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId!,
          client_secret: this.options.clientSecret!,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string') return null;
      const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
      this.token = { value: body.access_token, expiresAt: this.now() + Math.max(0, ttl - 60) * 1000 };
      return this.token.value;
    } catch {
      return null; // fall back to anonymous access
    }
  }

  private async api<T>(pathAndQuery: string): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${pathAndQuery}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new HttpError(502, 'provider_error', `Openverse request failed: ${(error as Error).message}`);
    }
    if (res.status === 401 && token) this.token = null;
    if (res.status === 404) throw new HttpError(404, 'not_found', 'Openverse item not found');
    if (res.status === 429) throw new HttpError(429, 'rate_limited', 'Openverse rate limit reached; try again later');
    if (!res.ok) throw new HttpError(502, 'provider_error', `Openverse responded with HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new HttpError(502, 'provider_error', 'Openverse returned invalid JSON');
    }
  }

  async search(q: string, { page, perPage }: ProviderSearchOptions): Promise<ProviderSearchResult> {
    const authed = (await this.getToken()) !== null;
    const size = Math.min(Math.max(1, perPage), authed ? AUTH_MAX_PAGE_SIZE : ANON_MAX_PAGE_SIZE);
    const p = Math.max(1, page);
    if (!authed && (p - 1) * size >= ANON_MAX_RESULTS) return { items: [], page: p, hasMore: false };
    const params = new URLSearchParams({ q, page: String(p), page_size: String(size) });
    const body = await this.api<OpenverseSearchResponse>(`/v1/images/?${params.toString()}`);
    const results = Array.isArray(body.results) ? body.results : [];
    const pageCount = typeof body.page_count === 'number' ? body.page_count : p;
    let hasMore = p < pageCount;
    if (!authed && p * size >= ANON_MAX_RESULTS) hasMore = false;
    return {
      items: results.filter((r) => r && typeof r.id === 'string' && ITEM_ID.test(r.id)).map(mapOpenverseImage),
      page: p,
      hasMore,
    };
  }

  async getDownload(itemId: string): Promise<ProviderDownload> {
    if (!ITEM_ID.test(itemId)) throw new HttpError(404, 'not_found', 'Openverse item not found');
    const img = await this.api<OpenverseImage>(`/v1/images/${encodeURIComponent(itemId)}/`);
    const item = mapOpenverseImage(img);
    if (!item.previewUrl) throw new HttpError(502, 'provider_error', 'Openverse item has no downloadable URL');
    return {
      url: item.previewUrl,
      attribution: {
        title: item.title,
        creator: item.creator,
        creatorUrl: item.creatorUrl,
        license: item.license,
        licenseUrl: item.licenseUrl,
        pageUrl: item.pageUrl,
        provider: this.id,
      },
    };
  }
}
