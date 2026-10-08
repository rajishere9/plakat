import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ASSET_BYTES } from '@plakat/schema';

/** Repository root (apps/server/src -> ../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MiB = 1024 * 1024;

export interface OpenverseConfig {
  clientId: string | null;
  clientSecret: string | null;
  /** API base, default https://api.openverse.org (overridable for tests/mirrors). */
  apiBase: string;
}

export interface Config {
  port: number;
  host: string;
  /** postgres:// connection string, or null to use embedded PGlite. */
  databaseUrl: string | null;
  /** When databaseUrl is null: 'memory' or a directory for the PGlite data files. */
  pglite: 'memory' | string;
  dataDir: string;
  uploadDir: string;
  templatesDir: string;
  /** Built SPA directory to serve (index.html fallback), or null. */
  webDist: string | null;
  /** Public base URL of this server (informational; used in logs). */
  publicUrl: string | null;
  /** Allowed CORS origin(s), comma separated; null = CORS disabled (same-origin only). */
  corsOrigin: string | null;
  /**
   * Extra Host header names accepted besides loopback/IP literals/single-label and
   * private-use names and PUBLIC_URL's host (DNS-rebinding guard). Entries starting
   * with "." match subdomains. `'*'` disables the check.
   */
  allowedHosts: string[] | '*';
  /** Optional HTTP Basic credentials required for every request except /api/health. */
  basicAuth: { user: string; password: string } | null;
  openverse: OpenverseConfig;
  /** Max JSON body (documents, imports, brand kits). */
  maxBodyBytes: number;
  /** Max upload / provider / remote-src download size (= schema MAX_ASSET_BYTES). */
  maxUploadBytes: number;
  /** Max thumbnail PNG size. */
  maxThumbnailBytes: number;
  logLevel: string;
}

function str(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = str(env, key);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${key}: ${v}`);
  return Math.floor(n);
}

function parseAllowedHosts(v: string | null): string[] | '*' {
  if (v === null) return [];
  const list = v
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.includes('*') ? '*' : list;
}

function parseBasicAuth(v: string | null): Config['basicAuth'] {
  if (v === null) return null;
  const i = v.indexOf(':');
  if (i < 1 || i === v.length - 1) throw new Error('Invalid BASIC_AUTH: expected "user:password"');
  return { user: v.slice(0, i), password: v.slice(i + 1) };
}

/** Reads configuration from environment variables (see .env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(str(env, 'DATA_DIR') ?? './data');
  const pgliteEnv = str(env, 'PGLITE');
  return {
    port: int(env, 'PORT', 8787),
    // Loopback by default: the API has no user accounts. The Docker image sets HOST=0.0.0.0.
    host: str(env, 'HOST') ?? '127.0.0.1',
    databaseUrl: str(env, 'DATABASE_URL'),
    pglite: pgliteEnv === 'memory' ? 'memory' : path.resolve(pgliteEnv ?? path.join(dataDir, 'pglite')),
    dataDir,
    uploadDir: path.resolve(str(env, 'UPLOAD_DIR') ?? path.join(dataDir, 'uploads')),
    templatesDir: path.resolve(str(env, 'TEMPLATES_DIR') ?? path.join(REPO_ROOT, 'templates')),
    webDist: str(env, 'WEB_DIST') ? path.resolve(str(env, 'WEB_DIST')!) : null,
    publicUrl: str(env, 'PUBLIC_URL'),
    corsOrigin: str(env, 'CORS_ORIGIN'),
    allowedHosts: parseAllowedHosts(str(env, 'ALLOWED_HOSTS')),
    basicAuth: parseBasicAuth(str(env, 'BASIC_AUTH')),
    openverse: {
      clientId: str(env, 'OPENVERSE_CLIENT_ID'),
      clientSecret: str(env, 'OPENVERSE_CLIENT_SECRET'),
      apiBase: (str(env, 'OPENVERSE_API_URL') ?? 'https://api.openverse.org').replace(/\/+$/, ''),
    },
    maxBodyBytes: int(env, 'MAX_BODY_MB', 40) * MiB,
    // One asset's byte cap: anything larger could never be embedded in a valid document.
    maxUploadBytes: MAX_ASSET_BYTES,
    maxThumbnailBytes: 2 * MiB,
    logLevel: str(env, 'LOG_LEVEL') ?? 'info',
  };
}
