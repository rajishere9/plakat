import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mapOpenverseImage, openverseLicenseLabel, OpenverseProvider } from '../assets/openverse.ts';
import { createTestApp, makeJpeg, makePng, type TestApp } from '../test-utils.ts';

const ITEM_ID = '4bc43a04-ef46-4544-a0c1-63c63f56e276';
const BAD_TYPE_ID = '11111111-2222-3333-4444-555555555555';
const PRIVATE_ID = '99999999-2222-3333-4444-555555555555';
const OV = 'https://api.openverse.org';

const ovImage = (id: string, url: string) => ({
  id,
  title: 'Mountain lake',
  indexed_on: '2020-01-01T00:00:00Z',
  foreign_landing_url: 'https://www.flickr.com/photos/someone/123',
  url,
  creator: 'Jane Doe',
  creator_url: 'https://www.flickr.com/photos/someone',
  license: 'by-sa',
  license_version: '2.0',
  license_url: 'https://creativecommons.org/licenses/by-sa/2.0/',
  provider: 'flickr',
  source: 'flickr',
  filetype: 'jpg',
  width: 1024,
  height: 768,
  thumbnail: `${OV}/v1/images/${id}/thumb/`,
  attribution: '"Mountain lake" by Jane Doe is licensed under CC BY-SA 2.0.',
});

const jpeg = makeJpeg(1024, 768);
let calls: { url: string; init?: RequestInit }[] = [];
let tokenRequests = 0;

const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push({ url, init });
  const u = new URL(url);
  if (u.origin === OV && u.pathname === '/v1/auth_tokens/token/') {
    tokenRequests++;
    return Response.json({ access_token: 'tok123', expires_in: 3600, token_type: 'Bearer' });
  }
  if (u.origin === OV && u.pathname === '/v1/images/') {
    const page = Number(u.searchParams.get('page'));
    return Response.json({
      result_count: 50,
      page_count: 3,
      page_size: Number(u.searchParams.get('page_size')),
      page,
      results: [ovImage(ITEM_ID, 'https://live.staticflickr.com/1/a.jpg'), { id: '../evil', title: 'x' }],
    });
  }
  if (u.origin === OV && u.pathname === `/v1/images/${ITEM_ID}/`) return Response.json(ovImage(ITEM_ID, 'https://live.staticflickr.com/1/a.jpg'));
  if (u.origin === OV && u.pathname === `/v1/images/${BAD_TYPE_ID}/`) return Response.json(ovImage(BAD_TYPE_ID, 'https://example.org/page.html'));
  if (u.origin === OV && u.pathname === `/v1/images/${PRIVATE_ID}/`) return Response.json(ovImage(PRIVATE_ID, 'http://intranet.local/secret.png'));
  if (u.origin === OV && u.pathname.startsWith('/v1/images/')) return new Response('{"detail":"Not found."}', { status: 404 });
  if (url === 'https://live.staticflickr.com/1/a.jpg') return new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg' } });
  if (url === 'https://example.org/page.html') return new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } });
  return new Response('unexpected', { status: 500 });
}) as typeof fetch;

const resolveHost = async (host: string) => (host === 'intranet.local' ? ['10.0.0.8'] : ['93.184.216.34']);

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ fetch: mockFetch, resolveHost });
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  calls = [];
});

describe('asset providers API', () => {
  it('lists providers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/asset-providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({ id: 'openverse', name: 'Openverse', requiresKey: false, configured: true, homepage: 'https://openverse.org' }),
    ]);
    expect(typeof res.json().items[0].licenseNote).toBe('string');
  });

  it('searches Openverse and maps fields', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/asset-providers/openverse/search?q=lake&page=2&perPage=50' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.page).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.items).toEqual([
      {
        id: ITEM_ID,
        title: 'Mountain lake',
        thumbUrl: `${OV}/v1/images/${ITEM_ID}/thumb/`,
        previewUrl: 'https://live.staticflickr.com/1/a.jpg',
        width: 1024,
        height: 768,
        creator: 'Jane Doe',
        creatorUrl: 'https://www.flickr.com/photos/someone',
        license: 'CC BY-SA 2.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/',
        pageUrl: 'https://www.flickr.com/photos/someone/123',
      },
    ]);
    const searchUrl = new URL(calls.find((c) => c.url.includes('/v1/images/?'))!.url);
    expect(searchUrl.searchParams.get('q')).toBe('lake');
    expect(searchUrl.searchParams.get('page')).toBe('2');
    expect(searchUrl.searchParams.get('page_size')).toBe('20'); // anonymous cap
  });

  it('validates search parameters and provider ids', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/asset-providers/openverse/search' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/asset-providers/openverse/search?q=a&page=0' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/asset-providers/nope/search?q=a' })).statusCode).toBe(404);
  });

  it('imports: downloads the full image into uploads with attribution', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/asset-providers/openverse/import', payload: { itemId: ITEM_ID } });
    expect(res.statusCode).toBe(201);
    const sha256 = createHash('sha256').update(jpeg).digest('hex');
    expect(res.json()).toEqual({
      src: `/uploads/${sha256}.jpg`,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 768,
      byteSize: jpeg.length,
      sha256,
      attribution: {
        title: 'Mountain lake',
        creator: 'Jane Doe',
        creatorUrl: 'https://www.flickr.com/photos/someone',
        license: 'CC BY-SA 2.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/',
        pageUrl: 'https://www.flickr.com/photos/someone/123',
        provider: 'openverse',
      },
    });
    const file = await t.app.inject({ method: 'GET', url: res.json().src });
    expect(file.rawPayload.equals(jpeg)).toBe(true);
    const row = await t.app.plakat.db.query<{ attribution: { provider: string } }>('SELECT attribution FROM uploads WHERE sha256 = $1', [sha256]);
    expect(row.rows[0]?.attribution.provider).toBe('openverse');
  });

  it('rejects non-image content types and stores nothing', async () => {
    const before = (await t.app.plakat.db.query<{ n: number }>('SELECT count(*)::int AS n FROM uploads')).rows[0]!.n;
    const res = await t.app.inject({ method: 'POST', url: '/api/asset-providers/openverse/import', payload: { itemId: BAD_TYPE_ID } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('bad_upstream_content');
    const after = (await t.app.plakat.db.query<{ n: number }>('SELECT count(*)::int AS n FROM uploads')).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('never fetches private addresses and never takes URLs from clients', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/asset-providers/openverse/import', payload: { itemId: PRIVATE_ID } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('upstream_url_refused');
    expect(calls.some((c) => c.url.includes('intranet.local'))).toBe(false);

    const urlAsId = await t.app.inject({
      method: 'POST',
      url: '/api/asset-providers/openverse/import',
      payload: { itemId: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(urlAsId.statusCode).toBe(404);
    expect(calls.some((c) => c.url.includes('169.254'))).toBe(false);
    expect((await t.app.inject({ method: 'POST', url: '/api/asset-providers/openverse/import', payload: { url: 'https://x' } })).statusCode).toBe(400);
  });

  it('404 for unknown items', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/asset-providers/openverse/import', payload: { itemId: 'aaaaaaaa-0000-0000-0000-000000000000' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('OpenverseProvider', () => {
  it('uses an OAuth client-credentials token when configured, and caches it', async () => {
    tokenRequests = 0;
    calls = [];
    const p = new OpenverseProvider({ clientId: 'id', clientSecret: 'secret', fetch: mockFetch });
    await p.search('lake', { page: 1, perPage: 40 });
    await p.search('lake', { page: 2, perPage: 40 });
    expect(tokenRequests).toBe(1);
    const tokenCall = calls.find((c) => c.url.endsWith('/v1/auth_tokens/token/'))!;
    expect(String(tokenCall.init?.body)).toContain('grant_type=client_credentials');
    const searchCall = calls.find((c) => c.url.includes('/v1/images/?'))!;
    expect((searchCall.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok123');
    expect(new URL(searchCall.url).searchParams.get('page_size')).toBe('40');
  });

  it('caps anonymous paging depth', async () => {
    const p = new OpenverseProvider({ fetch: mockFetch });
    expect(await p.search('lake', { page: 13, perPage: 20 })).toEqual({ items: [], page: 13, hasMore: false });
  });

  it('maps licenses and sanitizes URLs', () => {
    expect(openverseLicenseLabel('cc0', '1.0')).toBe('CC0 1.0');
    expect(openverseLicenseLabel('pdm', '1.0')).toBe('Public Domain Mark 1.0');
    expect(openverseLicenseLabel('by', null)).toBe('CC BY');
    expect(openverseLicenseLabel(null, '1.0')).toBeNull();
    const item = mapOpenverseImage({ id: 'x', url: 'javascript:alert(1)', thumbnail: null, creator_url: 'ftp://x', title: '' });
    expect(item).toMatchObject({ title: 'Untitled', previewUrl: null, thumbUrl: null, creatorUrl: null });
  });
});

describe('PNG import via provider', () => {
  it('stores the sniffed type even if the declared content-type differs within images', async () => {
    const png = makePng(2, 2);
    const fetchPngAsJpeg = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/images/')) return Response.json(ovImage(ITEM_ID, 'https://cdn.example/x.jpg'));
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const t2 = await createTestApp({ fetch: fetchPngAsJpeg, resolveHost });
    try {
      const res = await t2.app.inject({ method: 'POST', url: '/api/asset-providers/openverse/import', payload: { itemId: ITEM_ID } });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ mimeType: 'image/png', width: 2, height: 2 });
    } finally {
      await t2.close();
    }
  });
});
