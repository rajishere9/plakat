import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addSlot,
  convertToTemplate,
  createBrandKit,
  createDocument,
  createImageAsset,
  createImageElement,
  createTextElement,
  serializeDocument,
  type Asset,
  type PlakatDocument,
} from '@plakat/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ASSETS_PER_DOCUMENT, MAX_REMOTE_FETCHES_PER_REQUEST } from '../documents.ts';
import { seedBuiltInTemplates } from '../templates/seed.ts';
import { createTestApp, fakeResolveHost, makeGif, makePng, type TestApp } from '../test-utils.ts';

const png = makePng(4, 3, [9, 8, 7, 255]);
let fetched: string[] = [];
const mockFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  if (url === 'https://cdn.example/a.png') return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  if (url === 'https://cdn.example/page.html') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ fetch: mockFetch, resolveHost: fakeResolveHost });
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  fetched = [];
});

const uploadFiles = async () => (await readdir(t.app.plakat.uploads.dir)).filter((f) => !f.startsWith('.'));

/** A design with one image element per given asset src. */
function designWithImages(srcs: { src: string; mimeType?: Asset['mimeType'] }[], kind: 'design' | 'template' = 'design'): PlakatDocument {
  let doc = createDocument('instagram-post', { title: 'imgs', kind });
  for (const { src, mimeType } of srcs) {
    const { id, asset } = createImageAsset({ src, width: 4, height: 3, mimeType: mimeType ?? 'image/png' });
    doc.assets[id] = asset;
    doc.pages[0]!.elements.push(createImageElement(id, asset));
  }
  if (kind === 'template') {
    doc = convertToTemplate(doc, { category: 'test' });
    doc = addSlot(doc, doc.pages[0]!.elements[0]!.id).document;
  }
  return doc;
}

/** Distinct tiny GIFs: 14 bytes each, all accepted by the sniffer. */
function tinyGifDataUri(i: number): string {
  const gif = makeGif((i % 60000) + 1, Math.floor(i / 60000) + 1);
  return `data:image/gif;base64,${gif.toString('base64')}`;
}

describe('asset amplification limits', () => {
  it(`refuses documents with more than ${MAX_ASSETS_PER_DOCUMENT} assets and writes no files`, async () => {
    const before = await uploadFiles();
    const doc = createDocument('instagram-post', { title: 'amplify' });
    const tpl = designWithImages([{ src: `data:image/png;base64,${png.toString('base64')}` }], 'template');
    for (let i = 0; i <= MAX_ASSETS_PER_DOCUMENT; i++) {
      const asset: Asset = { type: 'image', mimeType: 'image/gif', width: 1, height: 1, src: tinyGifDataUri(i), name: '', source: null };
      doc.assets[`as_g${i}`] = asset;
      tpl.assets[`as_g${i}`] = asset;
    }
    for (const req of [
      { method: 'POST' as const, url: '/api/projects', payload: { document: doc } },
      { method: 'POST' as const, url: '/api/templates/import', headers: { 'content-type': 'application/json' }, payload: serializeDocument(tpl) },
    ]) {
      const res = await t.app.inject(req);
      expect(res.statusCode, req.url).toBe(413);
      expect(res.json().error.code).toBe('too_many_assets');
    }
    expect(await uploadFiles()).toEqual(before);
  });

  it('applies the same cap to brand kits', async () => {
    const kit = createBrandKit('Big kit');
    for (let i = 0; i <= MAX_ASSETS_PER_DOCUMENT; i++) {
      kit.assets[`as_k${i}`] = { type: 'image', mimeType: 'image/gif', width: 1, height: 1, src: tinyGifDataUri(i + 5000), name: '', source: null };
    }
    const res = await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: { kit } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('too_many_assets');
  });
});

describe('remote asset srcs are downloaded into uploads on save/import', () => {
  it('rewrites https srcs to /uploads (projects), and caches the download across autosaves', async () => {
    const doc = designWithImages([{ src: 'https://cdn.example/a.png' }]);
    const created = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(created.statusCode).toBe(201);
    const src = Object.values(created.json().document.assets as Record<string, Asset>)[0]!.src;
    expect(src).toMatch(/^\/uploads\/[a-f0-9]{64}\.png$/);
    expect(fetched).toEqual(['https://cdn.example/a.png']);
    const stored = await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(Object.values(stored.json().document.assets as Record<string, Asset>)[0]!.src).toBe(src);

    // The client keeps its own copy (remote src) and re-sends it on every autosave.
    const put = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: doc, baseVersion: 1 } });
    expect(put.statusCode).toBe(200);
    expect(fetched).toEqual(['https://cdn.example/a.png']);

    // And the portable download works (it used to 422 asset_not_bundlable).
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}/file` })).statusCode).toBe(200);
  });

  it('imports templates with remote srcs as uploads', async () => {
    const tpl = designWithImages([{ src: 'https://cdn.example/a.png' }], 'template');
    const res = await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': 'application/json' }, payload: serializeDocument(tpl) });
    expect(res.statusCode).toBe(201);
    const got = await t.app.inject({ method: 'GET', url: `/api/templates/${res.json().id}` });
    expect(Object.values(got.json().document.assets as Record<string, Asset>).map((a) => a.src)).toEqual([expect.stringMatching(/^\/uploads\//)]);
    expect((await t.app.inject({ method: 'GET', url: `/api/templates/${res.json().id}/file` })).statusCode).toBe(200);
  });

  it('refuses (422, naming the asset) unreachable, non-image, mistyped and private srcs', async () => {
    for (const [src, mimeType] of [
      ['https://cdn.example/missing.png', 'image/png'],
      ['https://cdn.example/page.html', 'image/png'],
      ['https://cdn.example/a.png', 'image/jpeg'],
      ['https://intranet.internal/secret.png', 'image/png'],
    ] as const) {
      const doc = designWithImages([{ src, mimeType }]);
      const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
      expect(res.statusCode, src).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'asset_fetch_failed', assetId: Object.keys(doc.assets)[0] });
    }
    expect(fetched).not.toContain('https://intranet.internal/secret.png');
  });

  it(`refuses more than ${MAX_REMOTE_FETCHES_PER_REQUEST} uncached remote srcs without fetching any`, async () => {
    const srcs = Array.from({ length: MAX_REMOTE_FETCHES_PER_REQUEST + 1 }, (_, i) => ({ src: `https://cdn.example/n${i}.png` }));
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: designWithImages(srcs) } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('too_many_remote_assets');
    expect(fetched).toEqual([]);
  });
});

describe('strings PostgreSQL cannot store (NUL, lone surrogates)', () => {
  it('are cleaned instead of failing the save with a 500', async () => {
    const doc = createDocument('instagram-post', { title: 'ti\u0000tle' });
    doc.pages[0]!.elements.push(createTextElement({ id: 'el_nul', content: 'a\u0000b' }), createTextElement({ id: 'el_sur', content: 'a\ud800b' }));
    const created = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(created.statusCode).toBe(201);
    const got = (await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).json().document as PlakatDocument;
    expect(got.meta.title).toBe('title');
    const content = Object.fromEntries(got.pages[0]!.elements.map((e) => [e.id, e.type === 'text' ? e.content : null]));
    expect(content).toEqual({ el_nul: 'ab', el_sur: 'a�b' });

    // Autosave of a design that gained a broken emoji ('😀'.slice(0, 1)).
    const edited = { ...doc, pages: [{ ...doc.pages[0]!, elements: [createTextElement({ id: 'el_emoji', content: `x${'😀'.slice(0, 1)}` })] }] };
    const put = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: edited, baseVersion: 1 } });
    expect(put.statusCode).toBe(200);

    const kit = { ...createBrandKit('Kit\u0000name') };
    const k = await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: { kit } });
    expect(k.statusCode).toBe(201);
    expect(k.json().kit.name).toBe('Kitname');
  });

  it('in template search parameters', async () => {
    for (const qs of ['?q=%00', '?category=a%00', '?q=%ED%A0%80']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/templates${qs}` });
      expect(res.statusCode, qs).toBe(200);
    }
  });
});

describe('built-in template ids', () => {
  it('user templates never keep a tpl_ id (import or create)', async () => {
    const tpl = { ...designWithImages([{ src: `data:image/png;base64,${png.toString('base64')}` }], 'template'), id: 'tpl_instagram-post_future' };
    const imported = await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': 'application/json' }, payload: serializeDocument(tpl) });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().id).not.toMatch(/^tpl_/);
    const created = await t.app.inject({ method: 'POST', url: '/api/templates', payload: { document: tpl } });
    expect(created.statusCode).toBe(201);
    expect(created.json().id).not.toMatch(/^tpl_/);
    expect((await t.app.inject({ method: 'GET', url: '/api/templates/tpl_instagram-post_future' })).statusCode).toBe(404);
  });

  it('seeding moves a user template that squats a built-in id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plakat-squat-'));
    try {
      const tpl = { ...designWithImages([{ src: `data:image/png;base64,${png.toString('base64')}` }], 'template'), id: 'tpl_squatted' };
      const userCopy = { ...tpl, meta: { ...tpl.meta, title: 'User copy' } };
      // A row stored before user imports got fresh ids.
      await t.app.plakat.db.query(
        `INSERT INTO templates (id, title, document, schema_version, built_in, size, page_count, slot_count) VALUES ($1, 'User copy', $2::jsonb, 1, false, '{}'::jsonb, 1, 1)`,
        ['tpl_squatted', JSON.stringify(userCopy)],
      );
      await writeFile(path.join(dir, 'squatted.plakat.json'), serializeDocument(tpl));
      const res = await seedBuiltInTemplates(t.app.plakat.db, t.app.plakat.uploads, dir);
      expect(res.loaded).toEqual(['tpl_squatted']);
      expect(res.skipped).toEqual([]);
      const items = (await t.app.inject({ method: 'GET', url: '/api/templates' })).json().items as { id: string; title: string; builtIn: boolean }[];
      expect(items.find((i) => i.id === 'tpl_squatted')).toMatchObject({ builtIn: true });
      expect(items.find((i) => i.title === 'User copy')).toMatchObject({ builtIn: false, id: expect.stringMatching(/^doc_/) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
