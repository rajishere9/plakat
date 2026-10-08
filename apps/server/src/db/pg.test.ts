/**
 * Exercises the production `pg` code path without a PostgreSQL server: PGlite exposed
 * over the wire protocol by @electric-sql/pglite-socket.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDocument, createTextElement } from '@plakat/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../test-utils.ts';
import { createPgDb, runMigrations, type Db } from './index.ts';

interface Server {
  pglite: PGlite;
  socket: PGLiteSocketServer;
  url: string;
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

async function startServer(): Promise<Server> {
  const pglite = new PGlite();
  await pglite.waitReady;
  const socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1', maxConnections: 20 });
  await socket.start();
  cleanups.push(() => pglite.close());
  cleanups.push(() => socket.stop());
  return { pglite, socket, url: `postgres://postgres:postgres@${socket.getServerConn()}/postgres` };
}

async function connect(url: string, log = { warn: (_o: unknown, _m?: string) => {} }): Promise<Db> {
  const db = await createPgDb(url, { log });
  cleanups.push(() => db.close());
  return db;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('pg driver (via pglite-socket)', () => {
  it('survives the server dropping idle pooled connections (no unhandled pool error)', async () => {
    const server = await startServer();
    const warnings: string[] = [];
    const db = await connect(server.url, { warn: (_o, m) => warnings.push(m ?? '') });
    await Promise.all([db.query('SELECT 1'), db.query('SELECT 2'), db.query('SELECT 3')]); // idle clients now pooled
    await server.socket.stop();
    // Without a pool 'error' listener this is an uncaught exception that kills the process.
    await until(() => warnings.length > 0);
    expect(warnings[0]).toMatch(/idle PostgreSQL connection/);
  });

  it('runs migrations safely when two instances start at once', async () => {
    const server = await startServer();
    const a = await connect(server.url);
    const b = await connect(server.url);
    const results = await Promise.allSettled([runMigrations(a), runMigrations(b)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const applied = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    expect(applied).toEqual(['001_init.sql']);
    expect((await a.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name)).toEqual(['001_init.sql']);
    expect(await runMigrations(b)).toEqual([]);
  });

  it('saves documents with NUL / lone surrogates instead of failing with 500', async () => {
    const server = await startServer();
    const db = await connect(server.url);
    const t = await createTestApp({ db });
    cleanups.push(() => t.close());
    const doc = createDocument('instagram-post', { title: 'ti\u0000tle' });
    doc.pages[0]!.elements.push(createTextElement({ content: 'a\u0000b\ud800' }));
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(res.statusCode).toBe(201);
    expect(res.json().document.meta.title).toBe('title');
    expect((await t.app.inject({ method: 'GET', url: '/api/templates?q=%00' })).statusCode).toBe(200);
  });

  it('transaction() rolls back on error', async () => {
    const server = await startServer();
    const db = await connect(server.url);
    await db.exec('CREATE TABLE tx_test (n int)');
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO tx_test VALUES (1)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await db.transaction((tx) => tx.query('INSERT INTO tx_test VALUES (2)'));
    expect((await db.query<{ n: number }>('SELECT n FROM tx_test')).rows).toEqual([{ n: 2 }]);
  });
});
