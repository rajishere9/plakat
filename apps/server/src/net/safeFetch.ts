import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HttpError } from '../errors.ts';

/** Resolves a hostname to IP addresses (injectable for tests). */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const dnsResolver: HostResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for globally routable unicast addresses (no loopback/private/link-local/etc.). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^::ffff:/i.test(ip)) return false;
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

/**
 * Throws HttpError 502 unless `url` is http(s) on a default port and every address its
 * host resolves to is public. (A DNS-rebinding window between this check and the
 * actual connection remains; URLs come from provider APIs, never from clients.)
 */
export async function assertPublicUrl(url: URL, resolveHost: HostResolver): Promise<void> {
  const fail = (why: string) => new HttpError(502, 'upstream_url_refused', `Refusing to fetch ${url.origin}: ${why}`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail('only http(s) is allowed');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw fail('non-standard port');
  if (url.username || url.password) throw fail('credentials in URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolveHost(host);
    } catch {
      throw fail('host does not resolve');
    }
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw fail('host resolves to a non-public address');
}

export interface SafeFetchOptions {
  fetch: typeof fetch;
  resolveHost: HostResolver;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

/**
 * GET with SSRF guards on every hop (redirects followed manually, max 5) and an
 * overall timeout. The returned response's body is not yet consumed.
 */
export async function fetchPublic(rawUrl: string, options: SafeFetchOptions): Promise<{ response: Response; url: URL }> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(502, 'upstream_url_refused', 'Provider returned an invalid URL');
  }
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url, options.resolveHost);
    let response: Response;
    try {
      response = await options.fetch(url, { redirect: 'manual', signal, headers: options.headers });
    } catch (error) {
      const timedOut = signal.aborted;
      throw new HttpError(timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_error', `Download failed: ${(error as Error).message}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => {});
      if (hop >= (options.maxRedirects ?? 5)) throw new HttpError(502, 'upstream_error', 'Too many redirects');
      url = new URL(response.headers.get('location')!, url);
      continue;
    }
    return { response, url };
  }
}

/** Reads a response body, aborting with HttpError 413 once it exceeds `maxBytes`. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(413, 'payload_too_large', `Remote file exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new HttpError(502, 'upstream_error', `Download failed: ${(error as Error).message}`);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'payload_too_large', `Remote file exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
