import { addBrandColor, addBrandLogo, createBrandKit, createImageAsset, setBrandFont } from '@plakat/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makePng, type TestApp } from '../test-utils.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

function sampleKit() {
  let kit = createBrandKit('Acme');
  kit = addBrandColor(kit, '#FF5E3A', 'Primary');
  kit = setBrandFont(kit, { role: 'heading', family: 'Playfair Display', weight: 700 }).kit;
  const png = makePng(5, 5);
  const { asset } = createImageAsset({ src: `data:image/png;base64,${png.toString('base64')}`, width: 5, height: 5, mimeType: 'image/png' });
  kit = addBrandLogo(kit, asset, 'Logo').kit;
  return kit;
}

describe('brand kits API', () => {
  it('CRUD', async () => {
    const kit = sampleKit();
    const created = await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: { kit } });
    expect(created.statusCode).toBe(201);
    const stored = created.json().kit;
    expect(stored.id).toBe(kit.id);
    expect(stored.colors[0].value).toBe('#ff5e3a');
    const logoAsset = stored.assets[stored.logos[0].assetId];
    expect(logoAsset.src).toMatch(/^\/uploads\/[a-f0-9]{64}\.png$/);

    const list = await t.app.inject({ method: 'GET', url: '/api/brand-kits' });
    expect(list.json().items.map((k: { id: string }) => k.id)).toContain(kit.id);

    const got = await t.app.inject({ method: 'GET', url: `/api/brand-kits/${kit.id}` });
    expect(got.json().kit).toEqual(stored);

    const renamed = { ...stored, name: 'Acme 2', id: 'bk_other' };
    const put = await t.app.inject({ method: 'PUT', url: `/api/brand-kits/${kit.id}`, payload: { kit: renamed } });
    expect(put.statusCode).toBe(200);
    expect(put.json().kit).toMatchObject({ id: kit.id, name: 'Acme 2' });

    const dup = await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: { kit } });
    expect(dup.json().kit.id).not.toBe(kit.id);

    expect((await t.app.inject({ method: 'DELETE', url: `/api/brand-kits/${kit.id}` })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/api/brand-kits/${kit.id}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PUT', url: `/api/brand-kits/${kit.id}`, payload: { kit } })).statusCode).toBe(404);
  });

  it('validates kits', async () => {
    const kit = createBrandKit('Bad');
    const badColor = { ...kit, colors: [{ id: 'bc_1', name: '', value: 'red' }] };
    const res = await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: { kit: badColor } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_brand_kit');
    expect(res.json().error.issues.length).toBeGreaterThan(0);
    expect((await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: { kit: { format: 'nope' } } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: {} })).statusCode).toBe(400);
    const future = await t.app.inject({ method: 'POST', url: '/api/brand-kits', payload: { kit: { ...kit, schemaVersion: 7 } } });
    expect(future.statusCode).toBe(400);
    expect(future.json().error).toMatchObject({ code: 'unsupported_schema_version', found: 7, supported: 1 });
  });
});
