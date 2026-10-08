import { createDocument, createImageAsset, createImageElement, createTextElement, type PlakatDocument } from '@plakat/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makePng, type TestApp } from '../test-utils.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

function sampleDesign(title = 'My design'): PlakatDocument {
  const doc = createDocument('instagram-post', { title, pageCount: 2 });
  doc.pages[0]!.elements.push(createTextElement({ content: 'Hello' }));
  return doc;
}

describe('projects API', () => {
  it('health', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'pglite' });
  });

  it('creates, reads, lists, updates and deletes', async () => {
    const doc = sampleDesign();
    const created = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ id: doc.id, version: 1 });
    expect(body.document.fonts).toEqual([{ family: 'Inter', source: 'google', variants: [{ weight: 400, style: 'normal' }] }]);
    expect(body.document.meta.updatedAt).toBe(body.updatedAt);
    expect(body.document.meta.createdAt).not.toBe('1970-01-01T00:00:00.000Z');

    const got = await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: doc.id, version: 1, document: { id: doc.id, meta: { title: 'My design' } } });

    const list = await t.app.inject({ method: 'GET', url: '/api/projects' });
    const item = list.json().items.find((i: { id: string }) => i.id === doc.id);
    expect(item).toMatchObject({ id: doc.id, title: 'My design', pageCount: 2, thumbnailUrl: null, size: { width: 1080, height: 1080 } });
    expect(typeof item.updatedAt).toBe('string');

    const edited = { ...got.json().document, meta: { ...got.json().document.meta, title: 'Renamed' } };
    const put = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: edited, baseVersion: 1 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: doc.id, version: 2 });

    const again = await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(again.json()).toMatchObject({ version: 2, document: { meta: { title: 'Renamed' } } });

    const del = await t.app.inject({ method: 'DELETE', url: `/api/projects/${doc.id}` });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/${doc.id}` })).statusCode).toBe(404);
  });

  it('rejects a stale baseVersion with 409 version_conflict', async () => {
    const doc = sampleDesign();
    await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    const ok = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: doc, baseVersion: 1 } });
    expect(ok.json().version).toBe(2);
    const stale = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: doc, baseVersion: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'version_conflict', currentVersion: 2 } });
    const missing = await t.app.inject({ method: 'PUT', url: '/api/projects/doc_nope', payload: { document: doc, baseVersion: 1 } });
    expect(missing.statusCode).toBe(404);
    const noVersion = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: doc } });
    expect(noVersion.statusCode).toBe(400);
  });

  it('forces the document id to the URL id on PUT', async () => {
    const doc = sampleDesign();
    await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    const other = { ...doc, id: 'doc_somethingElse' };
    await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: other, baseVersion: 1 } });
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).json().document.id).toBe(doc.id);
  });

  it('assigns a fresh id when the document id is already taken', async () => {
    const doc = sampleDesign();
    const a = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    const b = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(a.json().id).toBe(doc.id);
    expect(b.json().id).not.toBe(doc.id);
    expect(b.json().document.id).toBe(b.json().id);
  });

  it('400 with issues for an invalid document', async () => {
    const doc = sampleDesign() as unknown as Record<string, unknown>;
    const bad = { ...doc, pages: [], bogus: 1 };
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: bad } });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('invalid_document');
    expect(Array.isArray(err.issues)).toBe(true);
    expect(err.issues.length).toBeGreaterThan(0);

    const notObj = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: 'nope' } });
    expect(notObj.statusCode).toBe(400);
    const noDoc = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'x' } });
    expect(noDoc.statusCode).toBe(400);
    const future = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: { ...doc, schemaVersion: 99 } } });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('unsupported_schema_version');
  });

  it('rejects prototype-pollution payloads without polluting', async () => {
    const doc = sampleDesign();
    const json = JSON.stringify({ document: doc }).replace('"meta":{', '"meta":{"__proto__":{"polluted":true},');
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: json });
    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const ctor = JSON.stringify({ document: { ...doc, constructor: { prototype: { polluted: true } } } });
    const res2 = await t.app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: ctor });
    expect(res2.statusCode).toBe(400);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    // Reserved ids are refused by the schema loader too.
    const reservedId = { ...doc, id: '__proto__' };
    const res3 = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: reservedId } });
    expect(res3.statusCode).toBe(400);
  });

  it('migrates v0 documents on input', async () => {
    const v0 = { id: 'doc_legacy00001', width: 800, height: 600, pages: [{ id: 'pg_1', elements: [] }] };
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: v0 } });
    expect(res.statusCode).toBe(201);
    expect(res.json().document).toMatchObject({ schemaVersion: 1, size: { width: 800, height: 600 } });
  });

  it('moves embedded data: images into uploads', async () => {
    const png = makePng(4, 3);
    const doc = sampleDesign();
    const { id: assetId, asset } = createImageAsset({ src: `data:image/png;base64,${png.toString('base64')}`, width: 4, height: 3, mimeType: 'image/png' });
    doc.assets[assetId] = asset;
    doc.pages[0]!.elements.push(createImageElement(assetId, asset));
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(res.statusCode).toBe(201);
    const src: string = res.json().document.assets[assetId].src;
    expect(src).toMatch(/^\/uploads\/[a-f0-9]{64}\.png$/);
    const file = await t.app.inject({ method: 'GET', url: src });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(png)).toBe(true);

    // ...and the design file export bundles them back.
    const exported = await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}/file` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().assets[assetId].src).toBe(asset.src);
  });

  it('stores and serves PNG thumbnails', async () => {
    const doc = sampleDesign();
    await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    const png = makePng(8, 8);
    const put = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}/thumbnail`, headers: { 'content-type': 'image/png' }, payload: png });
    expect(put.statusCode).toBe(200);
    const url: string = put.json().thumbnailUrl;
    expect(url).toMatch(new RegExp(`^/api/projects/${doc.id}/thumbnail\\?v=\\d+$`));
    const got = await t.app.inject({ method: 'GET', url });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload.equals(png)).toBe(true);
    const list = await t.app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json().items.find((i: { id: string }) => i.id === doc.id).thumbnailUrl).toBe(url);

    const notPng = await t.app.inject({
      method: 'PUT',
      url: `/api/projects/${doc.id}/thumbnail`,
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('GIF89a......'),
    });
    expect(notPng.statusCode).toBe(415);
    const tooBig = await t.app.inject({
      method: 'PUT',
      url: `/api/projects/${doc.id}/thumbnail`,
      headers: { 'content-type': 'image/png' },
      payload: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
    });
    expect(tooBig.statusCode).toBe(413);
    const wrongType = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}/thumbnail`, headers: { 'content-type': 'image/jpeg' }, payload: png });
    expect(wrongType.statusCode).toBe(415);
    const missing = await t.app.inject({ method: 'PUT', url: '/api/projects/doc_missing1/thumbnail', headers: { 'content-type': 'image/png' }, payload: png });
    expect(missing.statusCode).toBe(404);
  });

  it('portable download drops unreferenced assets before bundling', async () => {
    const png = makePng(4, 3);
    const doc = sampleDesign('Pruned');
    const used = createImageAsset({ src: `data:image/png;base64,${png.toString('base64')}`, width: 4, height: 3, mimeType: 'image/png' });
    doc.assets[used.id] = used.asset;
    doc.pages[0]!.elements.push(createImageElement(used.id, used.asset));
    // Stale entries no element references: one that could never be bundled, one that could.
    doc.assets['as_stale_remote'] = { ...used.asset, src: '/not-an-upload/gone.png' };
    doc.assets['as_stale_data'] = { ...used.asset, name: 'stale' };
    const created = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(created.statusCode).toBe(201);
    expect(Object.keys(created.json().document.assets).sort()).toEqual(['as_stale_data', 'as_stale_remote', used.id].sort());
    const file = await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}/file` });
    expect(file.statusCode).toBe(200);
    const exported = file.json();
    expect(Object.keys(exported.assets)).toEqual([used.id]);
    expect(exported.assets[used.id].src).toBe(used.asset.src);
  });

  it('a stored document that cannot be exported is 422 not_exportable (not 400/500)', async () => {
    const doc = sampleDesign('Broken later');
    expect((await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } })).statusCode).toBe(201);
    await t.app.plakat.db.query(`UPDATE projects SET document = jsonb_set(document, '{pages}', '[]'::jsonb) WHERE id = $1`, [doc.id]);
    const res = await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}/file` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('not_exportable');
    expect(res.json().error.issues.length).toBeGreaterThan(0);
  });

  it('unknown API routes and invalid ids are JSON 404s', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect((await t.app.inject({ method: 'GET', url: '/api/projects/..%2F..%2Fetc' })).statusCode).toBe(404);
  });
});
