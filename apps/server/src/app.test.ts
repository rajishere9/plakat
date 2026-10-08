import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { runMigrations } from './db/index.ts';
import { HTML_CSP } from './security.ts';
import { createTestApp, type TestApp } from './test-utils.ts';

let t: TestApp;
let web: string;
beforeAll(async () => {
  web = await mkdtemp(path.join(tmpdir(), 'plakat-web-'));
  await mkdir(path.join(web, 'assets'));
  await writeFile(path.join(web, 'index.html'), '<!doctype html><title>Plakat</title>');
  await writeFile(path.join(web, 'assets', 'app-123.js'), 'console.log(1)');
  t = await createTestApp({ env: { WEB_DIST: web } });
});
afterAll(async () => {
  await t?.close();
  await rm(web, { recursive: true, force: true });
});

describe('app', () => {
  it('serves the SPA with index.html fallback, but JSON 404s under /api', async () => {
    const root = await t.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.payload).toContain('<title>Plakat</title>');
    const deep = await t.app.inject({ method: 'GET', url: '/editor/doc_123', headers: { accept: 'text/html' } });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    expect(deep.payload).toContain('<title>Plakat</title>');
    const asset = await t.app.inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    // Anti-framing + CSP on the SPA shell (index and the deep-link fallback).
    for (const r of [root, deep]) {
      expect(r.headers['content-security-policy']).toBe(HTML_CSP);
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(r.headers['referrer-policy']).toBe('same-origin');
    }
    const api = await t.app.inject({ method: 'GET', url: '/api/unknown' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    const health = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, db: 'pglite' });
  });

  it('migrations are idempotent', async () => {
    expect(await runMigrations(t.app.plakat.db)).toEqual([]);
    const { rows } = await t.app.plakat.db.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('001_init.sql');
  });

  it('JSON body limit', async () => {
    const small = await createTestApp({ env: { MAX_BODY_MB: '1' } });
    try {
      const res = await small.app.inject({ method: 'POST', url: '/api/projects', payload: { document: { pad: 'x'.repeat(1.5 * 1024 * 1024) } } });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('payload_too_large');
    } finally {
      await small.close();
    }
  });
});

describe('loadConfig', () => {
  it('defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 8787, host: '127.0.0.1', databaseUrl: null, webDist: null, publicUrl: null, allowedHosts: [], basicAuth: null });
    expect(c.pglite).toBe(path.resolve('data/pglite'));
    expect(c.uploadDir).toBe(path.resolve('data/uploads'));
    expect(c.templatesDir.endsWith(`${path.sep}templates`)).toBe(true);
    expect(c.openverse).toEqual({ clientId: null, clientSecret: null, apiBase: 'https://api.openverse.org' });
  });
  it('binds to loopback unless HOST is set; parses ALLOWED_HOSTS and BASIC_AUTH', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ ALLOWED_HOSTS: 'A.example, .b.example' }).allowedHosts).toEqual(['a.example', '.b.example']);
    expect(loadConfig({ ALLOWED_HOSTS: '*' }).allowedHosts).toBe('*');
    expect(loadConfig({ BASIC_AUTH: 'me:pa:ss' }).basicAuth).toEqual({ user: 'me', password: 'pa:ss' });
    expect(() => loadConfig({ BASIC_AUTH: 'nopassword' })).toThrow(/BASIC_AUTH/);
  });
  it('env overrides', () => {
    const c = loadConfig({ PORT: '9000', DATABASE_URL: 'postgres://x', PGLITE: 'memory', DATA_DIR: '/data', OPENVERSE_CLIENT_ID: 'a', OPENVERSE_CLIENT_SECRET: 'b' });
    expect(c).toMatchObject({ port: 9000, databaseUrl: 'postgres://x', pglite: 'memory', uploadDir: '/data/uploads', openverse: { clientId: 'a', clientSecret: 'b' } });
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
  });
});
