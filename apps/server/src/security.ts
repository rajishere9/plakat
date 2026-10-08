import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';

/**
 * Request guards for an instance that has no user accounts:
 *
 * - Host allow-list (DNS rebinding): a page on an attacker's domain that re-resolves
 *   to 127.0.0.1 or a LAN address talks to us with `Host: attacker.example`.
 * - Optional HTTP Basic auth (BASIC_AUTH=user:password).
 * - Cross-site write guard (CSRF): browsers send "simple" POSTs (multipart/form-data,
 *   text/plain) cross-origin without a preflight, so every state-changing request
 *   from a browser must come from this origin (or one listed in CORS_ORIGIN).
 * - Baseline response headers (anti-framing, referrer, nosniff, CSP for the SPA).
 */

/** Private-use / non-public suffixes that a remote attacker cannot point at us via public DNS. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** CSP for HTML documents (the SPA shell). Scripts only from this origin; never framed by others. */
export const HTML_CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Lower-cased hostname of a Host header value (without port / IPv6 brackets), or null if unparsable. */
export function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * True when `hostname` may be used to reach this server: IP literals, `localhost`,
 * single-label names (`app`, `nas`), private-use suffixes, PUBLIC_URL's host and
 * ALLOWED_HOSTS entries (`.example.com` matches example.com and its subdomains).
 */
export function isAllowedHostname(hostname: string, config: Pick<Config, 'allowedHosts' | 'publicUrl'>): boolean {
  if (config.allowedHosts === '*') return true;
  const h = hostname.replace(/\.$/, '');
  if (isIP(h)) return true;
  if (h === 'localhost' || !h.includes('.')) return true;
  if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (config.publicUrl) {
    try {
      if (new URL(config.publicUrl).hostname.toLowerCase() === h) return true;
    } catch {
      /* ignore an invalid PUBLIC_URL */
    }
  }
  return config.allowedHosts.some((entry) => (entry.startsWith('.') ? h === entry.slice(1) || h.endsWith(entry) : h === entry));
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function basicAuthOk(header: string | undefined, expected: { user: string; password: string }): boolean {
  const m = header ? /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header) : null;
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const userOk = timingSafeEqual(digest(decoded.slice(0, i)), digest(expected.user));
  const passOk = timingSafeEqual(digest(decoded.slice(i + 1)), digest(expected.password));
  return userOk && passOk;
}

/** Origins (scheme://host[:port]) allowed to send state-changing requests besides our own. */
function trustedOrigins(config: Pick<Config, 'corsOrigin' | 'publicUrl'>): Set<string> {
  const out = new Set<string>();
  for (const o of (config.corsOrigin ?? '').split(',')) {
    try {
      if (o.trim()) out.add(new URL(o.trim()).origin);
    } catch {
      /* ignore */
    }
  }
  if (config.publicUrl) {
    try {
      out.add(new URL(config.publicUrl).origin);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Decides whether a state-changing request may proceed. Browsers always attach
 * `Sec-Fetch-Site` (modern) and/or `Origin` (every cross-origin POST); requests with
 * neither come from non-browser clients, which CSRF does not concern.
 */
export function isSameOriginWrite(req: Pick<FastifyRequest, 'headers'>, trusted: Set<string>): boolean {
  const site = firstHeader(req.headers['sec-fetch-site']);
  if (site === 'same-origin' || site === 'none') return true;
  const origin = firstHeader(req.headers.origin);
  if (origin) {
    if (origin === 'null') return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (trusted.has(url.origin)) return true;
    // Compare as URLs so that default ports normalize (`Host: localhost:80` == `http://localhost`).
    const sameHost = (h: string | undefined) => {
      if (!h) return false;
      try {
        return new URL(`${url.protocol}//${h}`).host === url.host;
      } catch {
        return false;
      }
    };
    return sameHost(firstHeader(req.headers.host)) || sameHost(firstHeader(req.headers['x-forwarded-host']));
  }
  return site === undefined;
}

export function registerSecurity(app: FastifyInstance, config: Config): void {
  const trusted = trustedOrigins(config);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // 1) DNS-rebinding guard on the raw Host header (X-Forwarded-Host is attacker-settable same-origin).
    const hostHeader = firstHeader(req.headers.host);
    if (hostHeader) {
      const hostname = hostnameOf(hostHeader);
      if (!hostname || !isAllowedHostname(hostname, config)) {
        req.log.warn({ host: hostHeader }, 'rejected request for a host name that is not allowed (set PUBLIC_URL or ALLOWED_HOSTS)');
        return reply
          .code(403)
          .send(errorBody('host_not_allowed', `Host "${hostHeader.slice(0, 200)}" is not allowed; add it to ALLOWED_HOSTS or set PUBLIC_URL`));
      }
    }

    // 2) Optional shared-secret gate.
    if (config.basicAuth && req.url !== '/api/health' && !basicAuthOk(req.headers.authorization, config.basicAuth)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="Plakat", charset="UTF-8"')
        .send(errorBody('unauthorized', 'Authentication required'));
    }

    // 3) Cross-site write guard.
    if (!SAFE_METHODS.has(req.method) && !isSameOriginWrite(req, trusted)) {
      return reply.code(403).send(errorBody('cross_origin_request', 'Cross-origin write requests are not allowed'));
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('X-Content-Type-Options')) reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    const type = String(reply.getHeader('Content-Type') ?? '');
    if (/^text\/html\b/i.test(type) && !reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', HTML_CSP);
    return payload;
  });
}
