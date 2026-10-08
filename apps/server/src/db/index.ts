import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Config } from '../config.ts';

export type DbKind = 'postgres' | 'pglite';

/** Query/exec bound to one connection inside a transaction. */
export interface DbTx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

/** Minimal database facade shared by the pg Pool and PGlite implementations. */
export interface Db {
  readonly kind: DbKind;
  /** Parameterized query ($1, $2, ...). jsonb comes back parsed, bytea as Uint8Array/Buffer, timestamptz as Date. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs a multi-statement SQL script without parameters (migrations only). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in BEGIN/COMMIT on a single connection (ROLLBACK when it throws). */
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbLogger {
  warn(obj: unknown, msg?: string): void;
}

const consoleLogger: DbLogger = { warn: (obj, msg) => console.warn(msg ?? '', obj) };

export async function createPgDb(connectionString: string, options: { log?: DbLogger } = {}): Promise<Db> {
  const log = options.log ?? consoleLogger;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000, keepAlive: true });
  // pg-pool re-emits errors of idle clients (server restart, failover, idle/NAT timeouts) on
  // the Pool. Without a listener Node treats it as an unhandled 'error' event and the
  // process exits; with one, pg-pool just discards the broken client and reconnects later.
  pool.on('error', (err) => log.warn({ err }, 'idle PostgreSQL connection failed; it was discarded'));
  // Fail fast on bad credentials / unreachable server.
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return {
    kind: 'postgres',
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<R>(sql: string, params: unknown[] = []) {
            const res = await client.query(sql, params);
            return { rows: res.rows as R[] };
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/** `dataDir` = 'memory' for an in-memory database. */
export async function createPgliteDb(dataDir: 'memory' | string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir !== 'memory') await mkdir(dataDir, { recursive: true });
  const pg = dataDir === 'memory' ? new PGlite() : new PGlite(dataDir);
  await pg.waitReady;
  return {
    kind: 'pglite',
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params);
      return { rows: res.rows };
    },
    async exec(sql: string) {
      try {
        await pg.exec(sql);
      } catch (error) {
        await pg.exec('ROLLBACK').catch(() => {});
        throw error;
      }
    },
    transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      return pg.transaction((tx) =>
        fn({
          async query<R>(sql: string, params: unknown[] = []) {
            const res = await tx.query<R>(sql, params);
            return { rows: res.rows };
          },
          async exec(sql: string) {
            await tx.exec(sql);
          },
        }),
      );
    },
    close: () => pg.close(),
  };
}

export async function createDb(config: Pick<Config, 'databaseUrl' | 'pglite'>, options: { log?: DbLogger } = {}): Promise<Db> {
  return config.databaseUrl ? createPgDb(config.databaseUrl, options) : createPgliteDb(config.pglite);
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Advisory lock key serializing migrations across concurrently starting instances. */
const MIGRATION_LOCK = 727274;

/**
 * Applies `migrations/*.sql` in lexical order, each in its own transaction, recording
 * applied names in `schema_migrations`. Returns the names applied by this call.
 *
 * Safe when several instances start at once: each migration's transaction first takes
 * an advisory lock and then re-checks `schema_migrations`, so an instance that waited
 * for the lock skips what another one has just committed.
 */
export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  });
  const files = (await readdir(dir)).filter((f) => /^[A-Za-z0-9_.-]+\.sql$/.test(f)).sort();
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const ran = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const { rows } = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rows.length) return false;
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}
