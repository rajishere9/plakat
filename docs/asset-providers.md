# Asset providers

The editor's **Photos** panel searches stock-photo catalogs through *asset providers*. A provider is a small class on the server. Plakat ships one, **Openverse**, and this guide shows how to add another, using Unsplash as the worked example.

- [How a provider fits in](#how-a-provider-fits-in)
- [The `AssetProvider` interface](#the-assetprovider-interface)
- [Openverse (built in)](#openverse-built-in)
- [Example: adding Unsplash](#example-adding-unsplash)
- [Checklist for a new provider](#checklist-for-a-new-provider)

## How a provider fits in

```
 Photos panel ──GET /api/asset-providers──────────────▶ ProviderRegistry.list()
      │        ──GET /api/asset-providers/:id/search──▶ provider.search(q, { page, perPage })
      │        ──POST /api/asset-providers/:id/import { itemId }
      │                                                    │
      │                                                    ├─ provider.getDownload(itemId) → { url, attribution }
      │                                                    ├─ downloadPublicImage(url)  SSRF-guarded, ≤ 25 MiB, 30 s
      │                                                    └─ uploads.store(bytes, { attribution }) → /uploads/<sha256>.<ext>
      ▼
 the image is added to the design as an asset whose src is /uploads/…, with source = attribution
```

Three rules come from this design:

1. **Clients send item ids, never URLs.** The provider turns an id into a download URL on the server, so a client cannot make the server fetch an arbitrary address. `downloadPublicImage` additionally refuses private, loopback and link-local addresses after DNS resolution, follows redirects with the same check, caps the size and checks the bytes are a supported image.
2. **The image ends up in the server's own uploads.** The editor only draws same-origin images, which keeps the canvas untainted for export and makes designs independent of the provider staying online. This matters for providers whose terms require hotlinking; see [the Unsplash notes](#hotlinking-and-plakats-storage-model).
3. **Attribution travels with the image.** `getDownload` returns title, creator, license and links. They are stored with the upload and copied into the asset's `source` in the document, and the editor shows them for the image.

Search result thumbnails (`thumbUrl`) are shown in the panel directly from the provider's servers, in the user's browser.

## The `AssetProvider` interface

From [`apps/server/src/assets/provider.ts`](../apps/server/src/assets/provider.ts):

```ts
export interface AssetProvider {
  readonly id: string;            // URL segment and attribution.provider, e.g. 'openverse' (unique)
  readonly name: string;          // shown in the provider picker
  readonly description: string;   // one sentence under the search box
  readonly requiresKey: boolean;  // true if it cannot work at all without credentials
  readonly homepage: string;      // linked from the panel
  readonly licenseNote: string;   // fine print under the results (license / attribution rules)
  isConfigured(): boolean;        // false → the panel says "needs an API key", routes answer 503
  search(q: string, options: { page: number; perPage: number }): Promise<ProviderSearchResult>;
  getDownload(itemId: string): Promise<ProviderDownload>;   // throw HttpError 404 for unknown/invalid ids
}

interface ProviderSearchResult { items: ProviderItem[]; page: number; hasMore: boolean }

interface ProviderItem {
  id: string;                     // opaque to the client, sent back to /import
  title: string;
  thumbUrl: string | null;        // small preview for the grid
  previewUrl: string | null;
  width: number | null; height: number | null;
  creator: string | null; creatorUrl: string | null;
  license: string | null;         // human readable, e.g. "CC BY 2.0"
  licenseUrl: string | null;
  pageUrl: string | null;         // landing page of the original
}

interface ProviderDownload {
  url: string;                    // absolute http(s) URL of the image the server should download
  attribution: {
    title: string | null; creator: string | null; creatorUrl: string | null;
    license: string | null; licenseUrl: string | null; pageUrl: string | null;
    provider: string;             // the provider id
  };
}
```

What the routes ([`routes/assets.ts`](../apps/server/src/routes/assets.ts)) already do for you:

- `q` is trimmed, required and at most 200 characters; `page` is 1..1000 and `perPage` 1..50 (default 20). Clamp `perPage` further if your API has a lower maximum.
- An unknown provider id answers 404, and `isConfigured() === false` answers 503 `provider_not_configured`.
- `itemId` is a non-empty string of at most 200 characters. Validate its format yourself (Openverse accepts `^[A-Za-z0-9-]{1,64}$`) before putting it into an upstream URL.
- The download, size limit, type sniffing and storage happen after `getDownload`. If the bytes are not a supported image, the client gets 502 `bad_upstream_content`.

Errors: throw `HttpError` from [`errors.ts`](../apps/server/src/errors.ts). Openverse maps upstream failures to `502 provider_error`, 404 to `404 not_found` and 429 to `429 rate_limited`; the Photos panel has specific messages for network failures and rate limits.

Every URL you return in an item (`thumbUrl`, `pageUrl`, `licenseUrl`, …) should be an absolute `http(s)` URL or `null`. Openverse filters them with a small `httpUrl()` helper, because they become links and image sources in the editor.

## Openverse (built in)

[Openverse](https://openverse.org) indexes hundreds of millions of openly licensed images (Creative Commons and public domain) from Flickr, Wikimedia Commons, museums and more. The provider is [`assets/openverse.ts`](../apps/server/src/assets/openverse.ts).

| Variable | Default | |
|---|---|---|
| `OPENVERSE_CLIENT_ID`, `OPENVERSE_CLIENT_SECRET` | unset | Optional. With both set the server requests an OAuth client-credentials token (cached until shortly before it expires) and sends it as a bearer token. |
| `OPENVERSE_API_URL` | `https://api.openverse.org` | API base, for mirrors and tests. |

- **Without credentials** it works anonymously, with Openverse's lower rate limits, 20 results per page and results up to 240 deep (the provider stops paging there).
- **With credentials** pages hold up to 50 results. Register an application as described in the [Openverse API documentation](https://api.openverse.org/v1/#tag/auth). If the token request fails, the provider falls back to anonymous access.
- Licenses are shown as "CC BY-SA 2.0", "CC0 1.0" or "Public Domain Mark 1.0". Many Creative Commons licenses require attribution and some forbid commercial use or derivatives, which the panel's fine print says. Plakat stores the attribution, but checking that a use is allowed is up to the user.

## Example: adding Unsplash

This walk-through adds an Unsplash provider that is enabled when the operator sets `UNSPLASH_ACCESS_KEY`. The code is a sketch to adapt; check every detail against the current [Unsplash API documentation](https://unsplash.com/documentation) and [API guidelines](https://help.unsplash.com/en/collections/1655542-api-guidelines) before you ship it, because the terms change from time to time.

### Before you write code: Unsplash's terms

Unsplash's API terms include requirements that a provider has to meet. At the time of writing they are:

- **Access key.** Register an application at <https://unsplash.com/developers> to get an access key. New applications run in demo mode with a low hourly rate limit; production limits need an application review. Each Plakat operator uses their **own** key (bring your own key): never commit one.
- **Attribution.** Credit the photographer and Unsplash where the photo is shown, for example "Photo by Jane Doe on Unsplash", linking to the photographer's profile and to Unsplash with `utm_source=<your_app_name>&utm_medium=referral` on both links.
- **Download tracking.** When a user actually uses a photo (inserts it into a design), the app must call the photo's `links.download_location` endpoint. This is a counter, not the image itself.
- **Hotlinking.** Unsplash asks API clients to display photos using the image URLs the API returns (`urls.*`), not copies stored elsewhere.

#### Hotlinking and Plakat's storage model

Plakat **downloads** every provider image into its own uploads (see [How a provider fits in](#how-a-provider-fits-in)); it cannot hotlink, because the canvas must stay same-origin for export, and the server also internalizes remote image URLs when a design is saved. That conflicts with Unsplash's hotlinking requirement as written. Before you enable an Unsplash provider on a public instance, read the current guidelines and, if needed, ask Unsplash whether your use is acceptable. A provider for a catalog without such a rule (Openverse, Wikimedia Commons, or Pexels, depending on its current terms) fits Plakat's model directly. The rest of this guide still shows how a key-based provider with download tracking is built.

### 1. Configuration

Add the key to `Config` in [`apps/server/src/config.ts`](../apps/server/src/config.ts):

```ts
export interface Config {
  // …
  unsplash: { accessKey: string | null; appName: string };
}

// in loadConfig():
unsplash: {
  accessKey: str(env, 'UNSPLASH_ACCESS_KEY'),
  appName: str(env, 'UNSPLASH_APP_NAME') ?? 'plakat',   // used in the utm_source of attribution links
},
```

Document both variables in `.env.example`, forward them in `docker-compose.yml` (`UNSPLASH_ACCESS_KEY: ${UNSPLASH_ACCESS_KEY:-}`), and add them to the README's configuration table.

### 2. The provider

Create `apps/server/src/assets/unsplash.ts`:

```ts
import { HttpError } from '../errors.ts';
import type { AssetProvider, ProviderDownload, ProviderItem, ProviderSearchOptions, ProviderSearchResult } from './provider.ts';

const API = 'https://api.unsplash.com';
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PER_PAGE = 30;

interface UnsplashPhoto {
  id: string;
  description: string | null;
  alt_description: string | null;
  width: number;
  height: number;
  urls: { raw: string; full: string; regular: string; small: string; thumb: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

export interface UnsplashOptions {
  accessKey: string | null;
  appName: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class UnsplashProvider implements AssetProvider {
  readonly id = 'unsplash';
  readonly name = 'Unsplash';
  readonly description = 'High-resolution photos from the Unsplash community.';
  readonly requiresKey = true;
  readonly homepage = 'https://unsplash.com';
  readonly licenseNote = 'Photos are under the Unsplash License. Credit the photographer and Unsplash where you publish.';

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: UnsplashOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  isConfigured(): boolean {
    return Boolean(this.options.accessKey);
  }

  /** Adds the referral parameters Unsplash requires on attribution links. */
  private referral(url: string): string {
    const u = new URL(url);
    u.searchParams.set('utm_source', this.options.appName);
    u.searchParams.set('utm_medium', 'referral');
    return u.toString();
  }

  private async api<T>(pathAndQuery: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${pathAndQuery}`, {
        headers: { Authorization: `Client-ID ${this.options.accessKey}`, 'Accept-Version': 'v1' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new HttpError(502, 'provider_error', `Unsplash request failed: ${(error as Error).message}`);
    }
    if (res.status === 404) throw new HttpError(404, 'not_found', 'Unsplash photo not found');
    if (res.status === 403 || res.status === 429) throw new HttpError(429, 'rate_limited', 'Unsplash rate limit reached; try again later');
    if (!res.ok) throw new HttpError(502, 'provider_error', `Unsplash responded with HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private toItem(p: UnsplashPhoto): ProviderItem {
    return {
      id: p.id,
      title: p.description ?? p.alt_description ?? 'Untitled',
      thumbUrl: p.urls.small,
      previewUrl: p.urls.regular,
      width: p.width,
      height: p.height,
      creator: p.user.name,
      creatorUrl: this.referral(p.user.links.html),
      license: 'Unsplash License',
      licenseUrl: 'https://unsplash.com/license',
      pageUrl: this.referral(p.links.html),
    };
  }

  async search(q: string, { page, perPage }: ProviderSearchOptions): Promise<ProviderSearchResult> {
    const params = new URLSearchParams({ query: q, page: String(page), per_page: String(Math.min(perPage, MAX_PER_PAGE)) });
    const body = await this.api<{ total_pages: number; results: UnsplashPhoto[] }>(`/search/photos?${params}`);
    return {
      items: body.results.filter((p) => ITEM_ID.test(p.id)).map((p) => this.toItem(p)),
      page,
      hasMore: page < body.total_pages,
    };
  }

  async getDownload(itemId: string): Promise<ProviderDownload> {
    if (!ITEM_ID.test(itemId)) throw new HttpError(404, 'not_found', 'Unsplash photo not found');
    const photo = await this.api<UnsplashPhoto>(`/photos/${encodeURIComponent(itemId)}`);
    // Download tracking: Unsplash requires this call when a photo is used.
    // It must not block or fail the import, so errors are ignored.
    const track = new URL(photo.links.download_location);
    if (track.origin === API) void this.api(`${track.pathname}${track.search}`).catch(() => {});
    const item = this.toItem(photo);
    return {
      // `regular` is 1080 px wide; use `full` or `raw` with &w= for larger sizes (mind the 25 MiB cap).
      url: photo.urls.regular,
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
```

Notes on the sketch:

- The access key only ever travels server to Unsplash. The browser never sees it.
- `download_location` is checked to point at `api.unsplash.com` before it is called, so a malformed API response cannot redirect the key elsewhere.
- Unsplash image URLs (`images.unsplash.com`) are public HTTPS addresses, so `downloadPublicImage` accepts them; the server sniffs the bytes and stores them as JPEG.
- With `requiresKey = true` and no key, the provider still appears in the picker, and the Photos panel tells the user an administrator must configure it.

### 3. Register it

Providers are wired in `buildApp` ([`apps/server/src/app.ts`](../apps/server/src/app.ts)). Add the new one next to Openverse, passing the shared `fetch` so tests can mock it:

```ts
const providers = new ProviderRegistry(
  options.providers ?? [
    new OpenverseProvider({ /* … */ fetch: fetchImpl }),
    new UnsplashProvider({ accessKey: config.unsplash.accessKey, appName: config.unsplash.appName, fetch: fetchImpl }),
  ],
);
```

The first provider in the list is the panel's default. If you prefer to show Unsplash only when it is configured, add it conditionally (`...(config.unsplash.accessKey ? [new UnsplashProvider(…)] : [])`).

### 4. Tests

Copy the pattern of [`routes/assets.test.ts`](../apps/server/src/routes/assets.test.ts): build the app with `createTestApp({ providers: [new UnsplashProvider({ accessKey: 'test', appName: 'plakat', fetch: mockFetch })], fetch: mockFetch })` and a `mockFetch` that answers the API URLs and the image URL with fixtures (`makeJpeg()` from `test-utils.ts`). Tests never reach the network. Cover at least:

- search maps results, clamps `per_page` to 30, and sends `Authorization: Client-ID …`;
- `isConfigured()` is false without a key, and the routes answer 503;
- import stores the image under `/uploads/…` and returns the attribution with `utm_source` links;
- import calls `download_location` exactly once, and still succeeds when that call fails;
- an invalid id answers 404 without calling the API; upstream 429/403 answers 429.

### 5. Attribution in the editor

The editor already keeps provider attribution: the import response is turned into an asset with `source` filled in, and the image properties show the credit line. If a provider needs a specific wording ("Photo by … on Unsplash"), adjust `attributionLine()` in [`apps/web/src/api/attribution.ts`](../apps/web/src/api/attribution.ts) for that provider id, with a test.

## Checklist for a new provider

- [ ] The provider's API terms allow this use (storage of copies, attribution format, download tracking, rate limits), and the PR links to them
- [ ] Credentials come from environment variables, are documented in `.env.example`, the README table and `docker-compose.yml`, and never reach the browser
- [ ] Item ids are validated before they go into upstream URLs
- [ ] All returned URLs are absolute `http(s)` or `null`
- [ ] Upstream errors map to `HttpError` (404, 429, 502) with readable messages
- [ ] Attribution is complete: creator, license, links to the original
- [ ] Tests with a mocked `fetch` (no network), including the unconfigured case
- [ ] `licenseNote` tells users what they must do (credit, restrictions)
