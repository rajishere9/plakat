import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.ts';
import { assertPublicUrl, fetchPublic, isPublicAddress, readBodyCapped } from './safeFetch.ts';

describe('isPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip'])(
    'refuses %s',
    (ip) => expect(isPublicAddress(ip)).toBe(false),
  );
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe('assertPublicUrl', () => {
  const resolve = async (host: string) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);
  it('rejects private hosts, IP literals, odd ports, schemes and credentials', async () => {
    for (const url of [
      'http://internal.example/x.png',
      'http://127.0.0.1/x.png',
      'http://[::1]/x.png',
      'https://cdn.example:8443/x.png',
      'ftp://cdn.example/x.png',
      'file:///etc/passwd',
      'https://user:pw@cdn.example/x.png',
    ]) {
      await expect(assertPublicUrl(new URL(url), resolve), url).rejects.toBeInstanceOf(HttpError);
    }
    await expect(assertPublicUrl(new URL('https://cdn.example/x.png'), resolve)).resolves.toBeUndefined();
  });
});

describe('fetchPublic', () => {
  it('re-validates every redirect hop', async () => {
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://cdn.example/')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
      return new Response('secret');
    }) as typeof fetch;
    await expect(
      fetchPublic('https://cdn.example/a.png', { fetch: fetchMock, resolveHost: async () => ['93.184.216.34'], timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'upstream_url_refused' });
  });
});

describe('readBodyCapped', () => {
  it('aborts past the limit even without content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(600));
        c.enqueue(new Uint8Array(600));
        c.close();
      },
    });
    await expect(readBodyCapped(new Response(stream), 1000)).rejects.toMatchObject({ statusCode: 413 });
    expect((await readBodyCapped(new Response(new Uint8Array(10)), 1000)).byteLength).toBe(10);
  });
});
