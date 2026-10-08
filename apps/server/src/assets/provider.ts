/**
 * Pluggable stock-image providers. A provider searches a third-party catalog and
 * resolves an item id to a download URL + attribution; the SERVER downloads the
 * bytes into uploads (so the editor only draws same-origin images). Clients never
 * supply URLs to fetch — only item ids, which the provider resolves (SSRF safety).
 */

export interface ProviderSearchOptions {
  /** 1-based. */
  page: number;
  perPage: number;
}

export interface ProviderItem {
  id: string;
  title: string;
  thumbUrl: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  creator: string | null;
  creatorUrl: string | null;
  /** Human-readable license, e.g. "CC BY 2.0". */
  license: string | null;
  licenseUrl: string | null;
  /** Landing page of the original. */
  pageUrl: string | null;
}

export interface ProviderSearchResult {
  items: ProviderItem[];
  page: number;
  hasMore: boolean;
}

export interface ProviderAttribution {
  title: string | null;
  creator: string | null;
  creatorUrl: string | null;
  license: string | null;
  licenseUrl: string | null;
  pageUrl: string | null;
  /** Provider id. */
  provider: string;
}

export interface ProviderDownload {
  /** Absolute http(s) URL of the full image; fetched by the server with SSRF guards. */
  url: string;
  attribution: ProviderAttribution;
}

export interface AssetProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** True if the provider cannot work at all without credentials. */
  readonly requiresKey: boolean;
  readonly homepage: string;
  readonly licenseNote: string;
  isConfigured(): boolean;
  search(q: string, options: ProviderSearchOptions): Promise<ProviderSearchResult>;
  /** Throws HttpError 404 for unknown/invalid item ids. */
  getDownload(itemId: string): Promise<ProviderDownload>;
}

/** Public descriptor (GET /api/asset-providers). */
export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  requiresKey: boolean;
  configured: boolean;
  homepage: string;
  licenseNote: string;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AssetProvider>();

  constructor(providers: AssetProvider[] = []) {
    for (const p of providers) this.register(p);
  }

  register(provider: AssetProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate asset provider "${provider.id}"`);
    this.providers.set(provider.id, provider);
  }

  get(id: string): AssetProvider | undefined {
    return this.providers.get(id);
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      requiresKey: p.requiresKey,
      configured: p.isConfigured(),
      homepage: p.homepage,
      licenseNote: p.licenseNote,
    }));
  }
}
