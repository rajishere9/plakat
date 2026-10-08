import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addSlot,
  convertToTemplate,
  createDocument,
  createImageAsset,
  createImageElement,
  createShapeElement,
  createTextElement,
  isPortable,
  parseDocument,
  serializeDocument,
  type PlakatDocument,
} from '@plakat/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBuiltInTemplates } from '../templates/seed.ts';
import { createTestApp, makePng, type TestApp } from '../test-utils.ts';

/** A valid portable template built with the schema factories. */
function buildTemplate(id: string, title: string, category: string, color: [number, number, number, number] = [0, 128, 255, 255]): PlakatDocument {
  let doc = createDocument('instagram-post', { title, kind: 'template' });
  doc = { ...convertToTemplate(doc, { category }), id, meta: { ...doc.meta, tags: ['promo', 'summer'] } };
  const png = makePng(4, 3, color);
  const { id: assetId, asset } = createImageAsset({ src: `data:image/png;base64,${png.toString('base64')}`, width: 4, height: 3, mimeType: 'image/png' });
  const headline = createTextElement({ id: 'el_headline', content: 'Big sale' });
  const photo = createImageElement(assetId, asset, { id: 'el_photo' });
  const band = createShapeElement('rect', { id: 'el_band', fill: '#ff5e3a' });
  doc.assets[assetId] = asset;
  doc.pages[0]!.elements.push(band, photo, headline);
  doc = addSlot(doc, 'el_headline').document;
  doc = addSlot(doc, 'el_photo').document;
  doc = addSlot(doc, 'el_band').document;
  return doc;
}

let t: TestApp;
let templatesDir: string;
const builtIn = buildTemplate('tpl_builtin_sale', 'Summer sale', 'social/sale');

beforeAll(async () => {
  templatesDir = await mkdtemp(path.join(tmpdir(), 'plakat-templates-'));
  await mkdir(path.join(templatesDir, 'social'), { recursive: true });
  await writeFile(path.join(templatesDir, 'social', 'sale.plakat.json'), serializeDocument(builtIn));
  await writeFile(path.join(templatesDir, 'broken.plakat.json'), '{"format":"plakat.document","schemaVersion":1,"id":"x"}');
  await writeFile(path.join(templatesDir, 'design.plakat.json'), serializeDocument(createDocument('a4-poster', { title: 'Not a template' })));
  await writeFile(path.join(templatesDir, 'ignored.json'), '{}');
  t = await createTestApp({ templatesDir });
});
afterAll(async () => {
  await t?.close();
  await rm(templatesDir, { recursive: true, force: true });
});

describe('built-in template seeding', () => {
  it('loads valid templates and skips invalid ones', () => {
    const seed = t.app.plakat.seed!;
    expect(seed.loaded).toEqual(['tpl_builtin_sale']);
    expect(seed.skipped.map((s) => s.file).sort()).toEqual(['broken.plakat.json', 'design.plakat.json']);
  });

  it('lists built-ins with summary fields', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { id: string }) => i.id === 'tpl_builtin_sale');
    expect(item).toMatchObject({
      title: 'Summer sale',
      category: 'social/sale',
      size: { width: 1080, height: 1080 },
      pageCount: 1,
      slotCount: 3,
      thumbnailUrl: null,
      builtIn: true,
    });
  });

  it('serves the stored template with assets moved to uploads', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/templates/tpl_builtin_sale' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.builtIn).toBe(true);
    const srcs = Object.values(body.document.assets as Record<string, { src: string }>).map((a) => a.src);
    expect(srcs).toHaveLength(1);
    expect(srcs[0]).toMatch(/^\/uploads\/[a-f0-9]{64}\.png$/);
  });

  it('refuses to modify or delete built-ins (403)', async () => {
    const del = await t.app.inject({ method: 'DELETE', url: '/api/templates/tpl_builtin_sale' });
    expect(del.statusCode).toBe(403);
    expect(del.json().error.code).toBe('built_in_template');
    const put = await t.app.inject({ method: 'PUT', url: '/api/templates/tpl_builtin_sale', payload: { document: builtIn } });
    expect(put.statusCode).toBe(403);
  });

  it('re-seeding drops the thumbnail of a changed file and removes deleted files', async () => {
    const png = makePng(2, 2);
    const thumb = await t.app.inject({ method: 'PUT', url: '/api/templates/tpl_builtin_sale/thumbnail', headers: { 'content-type': 'image/png' }, payload: png });
    expect(thumb.statusCode).toBe(200);
    const { db, uploads } = t.app.plakat;

    // Unchanged file: thumbnail survives.
    await seedBuiltInTemplates(db, uploads, templatesDir);
    let item = (await t.app.inject({ method: 'GET', url: '/api/templates' })).json().items.find((i: { id: string }) => i.id === 'tpl_builtin_sale');
    expect(item.thumbnailUrl).toBe(thumb.json().thumbnailUrl);

    // Changed file: thumbnail reset.
    const changed = { ...builtIn, meta: { ...builtIn.meta, title: 'Summer sale v2' } };
    const file = path.join(templatesDir, 'social', 'sale.plakat.json');
    await writeFile(file, serializeDocument(changed));
    await seedBuiltInTemplates(db, uploads, templatesDir);
    item = (await t.app.inject({ method: 'GET', url: '/api/templates' })).json().items.find((i: { id: string }) => i.id === 'tpl_builtin_sale');
    expect(item).toMatchObject({ title: 'Summer sale v2', thumbnailUrl: null });

    // Deleted file: built-in removed; restore afterwards.
    await unlink(file);
    const res = await seedBuiltInTemplates(db, uploads, templatesDir);
    expect(res.removed).toEqual(['tpl_builtin_sale']);
    await writeFile(file, serializeDocument(builtIn));
    expect((await seedBuiltInTemplates(db, uploads, templatesDir)).loaded).toEqual(['tpl_builtin_sale']);
  });
});

describe('user templates', () => {
  it('CRUD with kind validation', async () => {
    const tpl = buildTemplate('tpl_user_card', 'Business card', 'print/card');
    const created = await t.app.inject({ method: 'POST', url: '/api/templates', payload: { document: tpl } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'tpl_user_card', builtIn: false, version: 1 });

    const edited = { ...tpl, meta: { ...tpl.meta, title: 'Card v2' } };
    const put = await t.app.inject({ method: 'PUT', url: '/api/templates/tpl_user_card', payload: { document: edited } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: 'tpl_user_card', version: 2 });
    const stale = await t.app.inject({ method: 'PUT', url: '/api/templates/tpl_user_card', payload: { document: edited, baseVersion: 1 } });
    expect(stale.statusCode).toBe(409);

    const got = await t.app.inject({ method: 'GET', url: '/api/templates/tpl_user_card' });
    expect(got.json()).toMatchObject({ builtIn: false, document: { meta: { title: 'Card v2' }, kind: 'template' } });

    const design = createDocument('a4-poster');
    const wrongKind = await t.app.inject({ method: 'POST', url: '/api/templates', payload: { document: design } });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().error.code).toBe('not_a_template');

    const invalid = await t.app.inject({ method: 'POST', url: '/api/templates', payload: { document: { ...tpl, template: { slots: [{ id: 'slot_x', kind: 'text', targets: ['el_missing'] }] } } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.issues.length).toBeGreaterThan(0);

    const del = await t.app.inject({ method: 'DELETE', url: '/api/templates/tpl_user_card' });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/templates/tpl_user_card' })).statusCode).toBe(404);
  });

  it('filters by category (prefix) and q', async () => {
    await t.app.inject({ method: 'POST', url: '/api/templates', payload: { document: buildTemplate('tpl_poster', 'Concert poster', 'print/poster') } });
    const ids = async (qs: string) =>
      ((await t.app.inject({ method: 'GET', url: `/api/templates${qs}` })).json().items as { id: string }[]).map((i) => i.id).sort();
    expect(await ids('?category=print')).toEqual(['tpl_poster']);
    expect(await ids('?category=print/poster')).toEqual(['tpl_poster']);
    expect(await ids('?category=prin')).toEqual([]);
    expect(await ids('?q=CONCERT')).toEqual(['tpl_poster']);
    expect(await ids('?q=summer')).toEqual(['tpl_builtin_sale', 'tpl_poster'].sort()); // tags
    expect(await ids('?q=sale%20summer')).toEqual(['tpl_builtin_sale']);
    expect(await ids('?q=%25')).toEqual([]);
  });
});

describe('portable export / import', () => {
  it('exports a bundled .plakat.json and imports it back', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/templates/tpl_builtin_sale/file' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="summer-sale\.plakat\.json"$/);
    expect(res.headers['content-type']).toMatch(/^application\/vnd\.plakat\+json/);
    const exported = parseDocument(res.payload);
    expect(isPortable(exported)).toBe(true);
    // Same bytes as the original data URI.
    expect(Object.values(exported.assets).map((a) => a.src)).toEqual(Object.values(builtIn.assets).map((a) => a.src));
    expect(exported.id).toBe('tpl_builtin_sale');

    // Import (raw text as application/json): the id is taken, so a fresh one is assigned.
    const imported = await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': 'application/json' }, payload: res.payload });
    expect(imported.statusCode).toBe(201);
    const newId: string = imported.json().id;
    expect(newId).not.toBe('tpl_builtin_sale');
    expect(imported.json().builtIn).toBe(false);
    const got = (await t.app.inject({ method: 'GET', url: `/api/templates/${newId}` })).json();
    expect(got.document.pages).toEqual((await t.app.inject({ method: 'GET', url: '/api/templates/tpl_builtin_sale' })).json().document.pages);
    // Round trip of the import.
    const reExported = parseDocument((await t.app.inject({ method: 'GET', url: `/api/templates/${newId}/file` })).payload);
    expect({ ...reExported, id: 'x', meta: null }).toEqual({ ...exported, id: 'x', meta: null });

    // Also accepts the vendor media type.
    const vendor = await t.app.inject({
      method: 'POST',
      url: '/api/templates/import',
      headers: { 'content-type': 'application/vnd.plakat+json' },
      payload: res.payload,
    });
    expect(vendor.statusCode).toBe(201);
  });

  it('rejects invalid imports', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': 'application/json' }, payload: '{"nope":1}' });
    expect(bad.statusCode).toBe(400);
    const notJson = await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': 'text/plain' }, payload: 'nope' });
    expect(notJson.statusCode).toBe(400);
    const design = await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': 'application/json' }, payload: serializeDocument(createDocument()) });
    expect(design.statusCode).toBe(400);
    expect(design.json().error.code).toBe('not_a_template');
  });

  it('refuses to bundle remote assets (never fetched server-side)', async () => {
    const tpl = buildTemplate('tpl_remote', 'Remote', 'x');
    const assetId = Object.keys(tpl.assets)[0]!;
    tpl.assets[assetId] = { ...tpl.assets[assetId]!, src: 'http://169.254.169.254/latest/meta-data.png' };
    expect((await t.app.inject({ method: 'POST', url: '/api/templates', payload: { document: tpl } })).statusCode).toBe(201);
    const res = await t.app.inject({ method: 'GET', url: '/api/templates/tpl_remote/file' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('asset_not_bundlable');
  });
});
