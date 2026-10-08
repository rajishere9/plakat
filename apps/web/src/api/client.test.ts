import { describe, expect, it, vi } from 'vitest';
import { createBrandKit, createDocument, DocumentValidationError } from '@plakat/schema';
import { ApiError, createApiClient, parseContentDispositionFilename, providerImportToAssetInput, uploadToAssetInput } from './client.ts';

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('api client', () => {
  it('projects: list/create/get/save/delete with validation', async () => {
    const doc = createDocument();
    const { fetch, calls } = mockFetch((url, init) => {
      if (url === '/api/projects' && init.method === 'GET') return json({ items: [{ id: 'p1', title: 'T', updatedAt: 'x', size: { width: 1, height: 1 }, pageCount: 1, thumbnailUrl: null }] });
      if (url === '/api/projects' && init.method === 'POST') return json({ id: 'p1', document: doc, version: 1, updatedAt: 'u' }, 201);
      if (url === '/api/projects/p1' && init.method === 'GET') return json({ id: 'p1', document: { ...doc, extra: 1 }, version: 1, updatedAt: 'u' });
      if (url === '/api/projects/p1' && init.method === 'PUT') return json({ id: 'p1', version: 2, updatedAt: 'v' });
      if (url === '/api/projects/p1' && init.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ error: { code: 'not_found', message: 'nope' } }, 404);
    });
    const api = createApiClient({ fetch });
    expect((await api.listProjects())[0]!.id).toBe('p1');
    const created = await api.createProject(doc);
    expect(created.document.id).toBe(doc.id);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ document: doc });
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    await expect(api.getProject('p1')).rejects.toBeInstanceOf(DocumentValidationError); // unknown key rejected
    expect(await api.saveProject('p1', doc, 1)).toEqual({ id: 'p1', version: 2, updatedAt: 'v' });
    expect(JSON.parse(calls[3]!.init.body as string).baseVersion).toBe(1);
    await api.deleteProject('p1');
    const err = await api.getProject('zz').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'nope', isNotFound: true });
  });

  it('maps 409 to a version_conflict ApiError and network failures to status 0', async () => {
    const { fetch } = mockFetch(() => json({ error: { code: 'version_conflict', message: 'stale' } }, 409));
    const api = createApiClient({ fetch });
    const e = await api.saveProject('p', createDocument(), 1).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 409, code: 'version_conflict', isConflict: true });
    const bad = createApiClient({ fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch });
    await expect(bad.health()).rejects.toMatchObject({ status: 0, code: 'network_error' });
    const plain = createApiClient({ fetch: (async () => new Response('oops', { status: 500, statusText: 'Server Error' })) as unknown as typeof globalThis.fetch });
    await expect(plain.health()).rejects.toMatchObject({ status: 500, code: 'http_500' });
  });

  it('templates: query string, file download, import, thumbnail, baseUrl', async () => {
    const tpl = createDocument('instagram-post', { kind: 'template' });
    const { fetch, calls } = mockFetch((url, init) => {
      if (url.startsWith('http://h/api/templates?')) return json({ items: [] });
      if (url === 'http://h/api/templates/t%201') return json({ id: 't 1', document: tpl, builtIn: true });
      if (url.endsWith('/file')) return new Response('{"x":1}', { headers: { 'Content-Disposition': `attachment; filename*=UTF-8''Sale%20post.plakat.json` } });
      if (url.endsWith('/import')) return json({ id: 'new' }, 201);
      if (url.endsWith('/thumbnail')) return json({ thumbnailUrl: '/thumbs/t.png' });
      if (init.method === 'POST') return json({ id: 'created' }, 201);
      return json({}, 500);
    });
    const api = createApiClient({ fetch, baseUrl: 'http://h/' });
    await api.listTemplates({ category: 'social', q: 'sale' });
    expect(calls[0]!.url).toBe('http://h/api/templates?category=social&q=sale');
    expect((await api.getTemplate('t 1')).builtIn).toBe(true);
    const f = await api.downloadTemplateFile('t 1');
    expect(f.filename).toBe('Sale post.plakat.json');
    expect(await f.blob.text()).toBe('{"x":1}');
    expect(await api.importTemplate(new Blob(['{"a":1}']))).toEqual({ id: 'new' });
    expect(calls.at(-1)!.init.body).toBe('{"a":1}');
    const png = new Blob([new Uint8Array([1])], { type: 'image/png' });
    expect(await api.uploadTemplateThumbnail('t 1', png)).toEqual({ thumbnailUrl: '/thumbs/t.png' });
    expect((calls.at(-1)!.init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect(calls.at(-1)!.init.method).toBe('PUT');
    expect(await api.createTemplate(tpl)).toEqual({ id: 'created' });
    expect(api.templateFileUrl('a/b')).toBe('http://h/api/templates/a%2Fb/file');
  });

  it('brand kits are validated', async () => {
    const kit = createBrandKit('Acme');
    const { fetch } = mockFetch((url, init) => {
      if (init.method === 'GET' && url === '/api/brand-kits') return json({ items: [kit] });
      if (init.method === 'POST') return json({ kit });
      if (init.method === 'GET') return json({ kit });
      if (init.method === 'PUT') return json({ kit: { ...kit, name: 'B' } });
      return new Response(null, { status: 204 });
    });
    const api = createApiClient({ fetch });
    expect((await api.listBrandKits())[0]!.name).toBe('Acme');
    expect((await api.createBrandKit(kit)).id).toBe(kit.id);
    expect((await api.getBrandKit(kit.id)).id).toBe(kit.id);
    expect((await api.updateBrandKit(kit.id, kit)).name).toBe('B');
    await api.deleteBrandKit(kit.id);
  });

  it('uploads via fetch (multipart) and via XHR with progress', async () => {
    const res = { src: '/uploads/abc.png', mimeType: 'image/png', width: 4, height: 3, byteSize: 10, sha256: 'abc' };
    const { fetch, calls } = mockFetch(() => json(res, 201));
    const api = createApiClient({ fetch, XMLHttpRequest: undefined });
    const file = new File([new Uint8Array([1, 2])], 'a.png', { type: 'image/png' });
    expect(await api.upload(file)).toEqual(res);
    const form = calls[0]!.init.body as FormData;
    expect((form.get('file') as File).name).toBe('a.png');

    const progress: number[] = [];
    class FakeXhr {
      static last: FakeXhr;
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 0;
      responseText = '';
      responseType = '';
      method = '';
      url = '';
      constructor() {
        FakeXhr.last = this;
      }
      open(m: string, u: string) {
        this.method = m;
        this.url = u;
      }
      setRequestHeader() {}
      abort() {
        this.onabort?.();
      }
      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
        this.status = 201;
        this.responseText = JSON.stringify(res);
        this.onload?.();
      }
    }
    const api2 = createApiClient({ fetch, XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest });
    expect(await api2.upload(file, { onProgress: (f) => progress.push(f) })).toEqual(res);
    expect(progress).toEqual([0.5, 1]);
    expect(FakeXhr.last.url).toBe('/api/uploads');
  });

  it('asset providers search/import and attribution mapping', async () => {
    const imported = {
      src: '/uploads/x.jpg',
      mimeType: 'image/jpeg' as const,
      width: 10,
      height: 5,
      byteSize: 1,
      sha256: 'x',
      attribution: { title: 'Sunset', creator: 'Jane', creatorUrl: null, license: 'CC BY 2.0', licenseUrl: 'https://cc.org/by/2.0', pageUrl: 'javascript:x', provider: 'openverse' },
    };
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('/search')) return json({ items: [], page: 2, hasMore: false });
      if (url.endsWith('/import')) return json(imported);
      return json({ items: [] });
    });
    const api = createApiClient({ fetch });
    await api.searchAssets('openverse', { q: 'cat dog', page: 2, perPage: 20 });
    expect(calls[0]!.url).toBe('/api/asset-providers/openverse/search?q=cat+dog&page=2&perPage=20');
    const r = await api.importAsset('openverse', 'item1');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ itemId: 'item1' });
    const input = providerImportToAssetInput(r, 'item1');
    expect(input.source).toEqual({
      provider: 'openverse',
      externalId: 'item1',
      pageUrl: null,
      author: 'Jane',
      license: 'CC BY 2.0',
      licenseUrl: 'https://cc.org/by/2.0',
      attribution: '"Sunset" by Jane, CC BY 2.0 (via openverse)',
    });
    expect(uploadToAssetInput(imported, 'pic').source.provider).toBe('upload');
  });

  it('parses Content-Disposition', () => {
    expect(parseContentDispositionFilename('attachment; filename="a b.json"')).toBe('a b.json');
    expect(parseContentDispositionFilename(null)).toBeNull();
  });
});
