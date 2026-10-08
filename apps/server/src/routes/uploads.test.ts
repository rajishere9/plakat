import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeGif, makeJpeg, makePng, makeWebpVp8x, multipartBody, type TestApp } from '../test-utils.ts';
import { SVG_CSP } from './uploads.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

const upload = (data: Buffer, filename = 'file.bin', contentType = 'application/octet-stream', field = 'file') => {
  const { payload, headers } = multipartBody(field, filename, contentType, data);
  return t.app.inject({ method: 'POST', url: '/api/uploads', payload, headers });
};

describe('POST /api/uploads', () => {
  it.each([
    ['png', makePng(33, 21), 'image/png', 33, 21, 'png'],
    ['jpeg', makeJpeg(800, 600, { orientation: 6 }), 'image/jpeg', 600, 800, 'jpg'],
    ['webp', makeWebpVp8x(1920, 1080), 'image/webp', 1920, 1080, 'webp'],
    ['gif', makeGif(64, 32), 'image/gif', 64, 32, 'gif'],
    ['svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="10" height="10"/></svg>'), 'image/svg+xml', 120, 80, 'svg'],
  ] as const)('stores %s with sniffed dimensions', async (_name, data, mimeType, width, height, ext) => {
    // Client-declared type is ignored: always sent as octet-stream with a misleading name.
    const res = await upload(data, 'photo.txt');
    expect(res.statusCode).toBe(201);
    const sha256 = createHash('sha256').update(data).digest('hex');
    expect(res.json()).toEqual({ src: `/uploads/${sha256}.${ext}`, mimeType, width, height, byteSize: data.length, sha256 });

    const file = await t.app.inject({ method: 'GET', url: res.json().src });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe(mimeType);
    expect(file.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.rawPayload.equals(data)).toBe(true);
    if (mimeType === 'image/svg+xml') expect(file.headers['content-security-policy']).toBe(SVG_CSP);
    else expect(file.headers['content-security-policy']).toBeUndefined();

    const etag = file.headers['etag'] as string;
    const cached = await t.app.inject({ method: 'GET', url: res.json().src, headers: { 'if-none-match': etag } });
    expect(cached.statusCode).toBe(304);
  });

  it('is idempotent per content hash', async () => {
    const png = makePng(3, 3, [1, 2, 3, 255]);
    const a = await upload(png);
    const b = await upload(png);
    expect(a.json()).toEqual(b.json());
    const files = (await readdir(t.config.uploadDir)).filter((f) => f.startsWith(a.json().sha256));
    expect(files).toHaveLength(1);
  });

  it('rejects unsupported types', async () => {
    const html = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'x.svg', 'image/svg+xml');
    expect(html.statusCode).toBe(415);
    expect(html.json().error.code).toBe('unsupported_media_type');
    const bmp = await upload(Buffer.from('BM\x00\x00\x00\x00'), 'x.png', 'image/png');
    expect(bmp.statusCode).toBe(415);
    const empty = await upload(Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
  });

  it('rejects oversize files (413)', async () => {
    const big = Buffer.concat([makePng(1, 1), Buffer.alloc(25 * 1024 * 1024)]);
    const res = await upload(big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });

  it('requires multipart with field "file"', async () => {
    const wrongField = await upload(makePng(1, 1), 'a.png', 'image/png', 'image');
    expect(wrongField.statusCode).toBe(400);
    const json = await t.app.inject({ method: 'POST', url: '/api/uploads', payload: { file: 'x' } });
    expect(json.statusCode).toBe(415);
  });
});

describe('GET /uploads/:file', () => {
  it('only serves content-addressed names (no traversal)', async () => {
    for (const url of [
      '/uploads/..%2F..%2Fpackage.json',
      '/uploads/../package.json',
      '/uploads/%2e%2e/%2e%2e/etc/passwd',
      '/uploads/..%5C..%5Cpackage.json',
      `/uploads/${'a'.repeat(64)}.png`,
      `/uploads/${'a'.repeat(64)}.html`,
      '/uploads/.gitignore',
      '/uploads/',
    ]) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
