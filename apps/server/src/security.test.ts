import { readdir } from 'node:fs/promises';
import { createDocument, serializeDocument } from '@plakat/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostnameOf, isAllowedHostname, isSameOriginWrite } from './security.ts';
import { createTestApp, makePng, multipartBody, type TestApp } from './test-utils.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGIN: 'https://spa.example.com' } });
});
afterAll(async () => {
  await t?.close();
});

const uploadFiles = async () => (await readdir(t.app.plakat.uploads.dir)).filter((f) => !f.startsWith('.'));

describe('cross-site write guard (CSRF)', () => {
  it('refuses a cross-site multipart upload and stores nothing', async () => {
    const before = await uploadFiles();
    const { payload, headers } = multipartBody('file', 'x.png', 'image/png', makePng(3, 3, [1, 2, 3, 255]));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...headers, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('cross_origin_request');
    expect(await uploadFiles()).toEqual(before);
  });

  it('refuses a foreign Origin even without Sec-Fetch-Site, and Sec-Fetch-Site cross-site without Origin', async () => {
    const body = serializeDocument(createDocument('instagram-post', { title: 'Injected', kind: 'template' }));
    for (const extra of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'null' }]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/templates/import',
        headers: { 'content-type': 'application/json', ...extra },
        payload: body,
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(403);
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/templates' })).json().items).toEqual([]);
  });

  it('allows same-origin browsers, CORS_ORIGIN origins and non-browser clients', async () => {
    const doc = createDocument('a4-poster', { title: 'ok' });
    const cases: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5173' }, // Vite dev proxy (changeOrigin)
      { origin: 'http://localhost' }, // inject's Host is localhost:80
      { origin: 'https://spa.example.com', 'sec-fetch-site': 'cross-site' },
      {}, // curl / scripts
    ];
    for (const headers of cases) {
      const res = await t.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { document: doc } });
      expect(res.statusCode, JSON.stringify(headers)).toBe(201);
    }
  });

  it('never blocks safe methods', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/projects', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(200);
  });

  it('isSameOriginWrite honours X-Forwarded-Host from a reverse proxy', () => {
    const trusted = new Set<string>();
    expect(isSameOriginWrite({ headers: { origin: 'https://plakat.example.com', host: 'app:8787', 'x-forwarded-host': 'plakat.example.com' } }, trusted)).toBe(true);
    expect(isSameOriginWrite({ headers: { origin: 'https://plakat.example.com:8443', host: 'plakat.example.com' } }, trusted)).toBe(false);
  });
});

describe('Host allow-list (DNS rebinding)', () => {
  it('rejects unknown host names but accepts loopback, IPs and single-label names', async () => {
    const evil = await t.app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.example' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('host_not_allowed');
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', '192.168.1.20', 'app:8787', 'nas.local', 'plakat.localhost']) {
      expect((await t.app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode, host).toBe(200);
    }
  });

  it('accepts PUBLIC_URL and ALLOWED_HOSTS', async () => {
    const t2 = await createTestApp({ env: { PUBLIC_URL: 'https://plakat.example.com', ALLOWED_HOSTS: '.example.org, other.test' } });
    try {
      for (const [host, status] of [
        ['plakat.example.com', 200],
        ['example.org', 200],
        ['a.b.example.org', 200],
        ['other.test:8787', 200],
        ['evil.example.com', 403],
        ['notexample.org', 403],
      ] as const) {
        expect((await t2.app.inject({ method: 'GET', url: '/api/projects', headers: { host } })).statusCode, host).toBe(status);
      }
    } finally {
      await t2.close();
    }
    expect(isAllowedHostname('anything.example', { allowedHosts: '*', publicUrl: null })).toBe(true);
    expect(hostnameOf('[::1]:80')).toBe('::1');
    expect(hostnameOf('Evil.Example.:80')).toBe('evil.example.');
    expect(isAllowedHostname('evil.example.', { allowedHosts: [], publicUrl: null })).toBe(false);
  });
});

describe('optional basic auth', () => {
  it('requires credentials everywhere except /api/health', async () => {
    const t2 = await createTestApp({ env: { BASIC_AUTH: 'admin:s3cret:with-colon' } });
    try {
      const anon = await t2.app.inject({ method: 'GET', url: '/api/projects' });
      expect(anon.statusCode).toBe(401);
      expect(anon.headers['www-authenticate']).toMatch(/^Basic realm="Plakat"/);
      const wrong = await t2.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` } });
      expect(wrong.statusCode).toBe(401);
      const ok = await t2.app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { authorization: `Basic ${Buffer.from('admin:s3cret:with-colon').toString('base64')}` },
      });
      expect(ok.statusCode).toBe(200);
      expect((await t2.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    } finally {
      await t2.close();
    }
  });
});

describe('baseline response headers', () => {
  it('API responses are not frameable and send no cross-origin referrer', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
