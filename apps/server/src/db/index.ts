import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Config } from '../config.ts';

export type DbKind = 'postgres' | 'pglite';

/** Minimal database facade shared by the pg Pool and PGlite implementations. */
export interface Db {
  readonly kind: DbKind;
  /** Parameterized query ($1, $2, ...). jsonb comes back parsed, bytea as Uint8Array/Buffer, timestamptz as Date. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs a multi-statement SQL script without parameters (migrations only). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function createPgDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Fail fast on bad credentials / unreachable server.
  await pool.query('SELECT 1');
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
    close: () => pg.close(),
  };
}

export async function createDb(config: Pick<Config, 'databaseUrl' | 'pglite'>): Promise<Db> {
  return config.databaseUrl ? createPgDb(config.databaseUrl) : createPgliteDb(config.pglite);
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies `migrations/*.sql` in lexical order, each in its own transaction, recording
 * applied names in `schema_migrations`. Returns the names applied by this call.
 */
export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(dir)).filter((f) => /^[A-Za-z0-9_.-]+\.sql$/.test(f)).sort();
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    // `file` matches [A-Za-z0-9_.-]+ so it is safe to inline as a literal.
    await db.exec(
      `BEGIN;\nSELECT pg_advisory_xact_lock(727274);\n${sql}\n;INSERT INTO schema_migrations (name) VALUES ('${file}');\nCOMMIT;`,
    );
    applied.push(file);
  }
  return applied;
}
