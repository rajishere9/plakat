import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  openverse: OpenverseConfig;
  /** Max JSON body (documents, imports, brand kits). */
  maxBodyBytes: number;
  /** Max upload / provider download size. */
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

/** Reads configuration from environment variables (see .env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(str(env, 'DATA_DIR') ?? './data');
  const pgliteEnv = str(env, 'PGLITE');
  return {
    port: int(env, 'PORT', 8787),
    host: str(env, 'HOST') ?? '0.0.0.0',
    databaseUrl: str(env, 'DATABASE_URL'),
    pglite: pgliteEnv === 'memory' ? 'memory' : path.resolve(pgliteEnv ?? path.join(dataDir, 'pglite')),
    dataDir,
    uploadDir: path.resolve(str(env, 'UPLOAD_DIR') ?? path.join(dataDir, 'uploads')),
    templatesDir: path.resolve(str(env, 'TEMPLATES_DIR') ?? path.join(REPO_ROOT, 'templates')),
    webDist: str(env, 'WEB_DIST') ? path.resolve(str(env, 'WEB_DIST')!) : null,
    publicUrl: str(env, 'PUBLIC_URL'),
    corsOrigin: str(env, 'CORS_ORIGIN'),
    openverse: {
      clientId: str(env, 'OPENVERSE_CLIENT_ID'),
      clientSecret: str(env, 'OPENVERSE_CLIENT_SECRET'),
      apiBase: (str(env, 'OPENVERSE_API_URL') ?? 'https://api.openverse.org').replace(/\/+$/, ''),
    },
    maxBodyBytes: int(env, 'MAX_BODY_MB', 40) * MiB,
    maxUploadBytes: 25 * MiB,
    maxThumbnailBytes: 2 * MiB,
    logLevel: str(env, 'LOG_LEVEL') ?? 'info',
  };
}
