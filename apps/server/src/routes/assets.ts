import type { FastifyInstance } from 'fastify';
import { bodyField, type AppContext } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { fetchPublic, readBodyCapped } from '../net/safeFetch.ts';
import type { AssetProvider } from '../assets/provider.ts';

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const DOWNLOAD_TIMEOUT_MS = 30_000;

function getProvider(ctx: AppContext, params: unknown): AssetProvider {
  const id = (params as { id?: unknown }).id;
  const provider = typeof id === 'string' ? ctx.providers.get(id) : undefined;
  if (!provider) throw notFound('Asset provider');
  if (!provider.isConfigured()) throw new HttpError(503, 'provider_not_configured', `${provider.name} is not configured on this server`);
  return provider;
}

function intQuery(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, 'bad_request', `Invalid paging parameter "${String(v)}"`);
  return Math.min(n, max);
}

export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/asset-providers', async () => ({ items: ctx.providers.list() }));

  app.get('/api/asset-providers/:id/search', async (req) => {
    const provider = getProvider(ctx, req.params);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const q = typeof query['q'] === 'string' ? query['q'].trim() : '';
    if (!q) throw new HttpError(400, 'bad_request', 'Query parameter "q" is required');
    if (q.length > 200) throw new HttpError(400, 'bad_request', 'Query is too long (max 200 characters)');
    const page = intQuery(query['page'], 1, 1, 1000);
    const perPage = intQuery(query['perPage'], 20, 1, 50);
    return provider.search(q, { page, perPage });
  });

  app.post('/api/asset-providers/:id/import', async (req, reply) => {
    const provider = getProvider(ctx, req.params);
    const itemId = bodyField(req.body, 'itemId');
    if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 200) {
      throw new HttpError(400, 'bad_request', '"itemId" must be a non-empty string');
    }
    // The provider resolves the URL; clients never supply one (SSRF safety).
    const download = await provider.getDownload(itemId);
    const { response } = await fetchPublic(download.url, {
      fetch: ctx.fetch,
      resolveHost: ctx.resolveHost,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      headers: { Accept: 'image/*', 'User-Agent': 'Plakat/0.1 (self-hosted design editor)' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(502, 'upstream_error', `Image download failed with HTTP ${response.status}`);
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(502, 'bad_upstream_content', `Provider returned unsupported content type "${contentType || 'none'}"`);
    }
    const bytes = await readBodyCapped(response, ctx.config.maxUploadBytes);
    let stored;
    try {
      stored = await ctx.uploads.store(bytes, { filename: `${provider.id}-${itemId}`, attribution: download.attribution });
    } catch (error) {
      if (error instanceof HttpError && (error.statusCode === 415 || error.statusCode === 400)) {
        throw new HttpError(502, 'bad_upstream_content', 'Provider returned data that is not a supported image');
      }
      throw error;
    }
    return reply.code(201).send({ ...stored, attribution: download.attribution });
  });
}
