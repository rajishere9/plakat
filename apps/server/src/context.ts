import { isValidId } from '@plakat/schema';
import type { ProviderRegistry } from './assets/provider.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { HttpError, notFound } from './errors.ts';
import type { HostResolver } from './net/safeFetch.ts';
import type { UploadStore } from './storage/uploads.ts';

/** Everything route modules need; built once by buildApp(). */
export interface AppContext {
  config: Config;
  db: Db;
  uploads: UploadStore;
  providers: ProviderRegistry;
  fetch: typeof fetch;
  resolveHost: HostResolver;
  now: () => Date;
}

/** Reads `:id` from route params; invalid ids are simply "not found". */
export function idParam(params: unknown, what: string): string {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (!isValidId(id)) throw notFound(what);
  return id;
}

/** Requires a JSON object body with the given field. */
export function bodyField(body: unknown, field: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !Object.hasOwn(body, field)) {
    throw new HttpError(400, 'bad_request', `Request body must be a JSON object with "${field}"`);
  }
  return (body as Record<string, unknown>)[field];
}

export const toIso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** bytea comes back as Buffer (pg) or Uint8Array (PGlite). */
export const toBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array));
