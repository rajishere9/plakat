import { createId, parseDocument, type PageSize, type PlakatDocument } from '@plakat/schema';
import type { FastifyInstance } from 'fastify';
import { bodyField, idParam, toIso, type AppContext } from '../context.ts';
import {
  bundleDocumentForExport,
  documentSummary,
  escapeLike,
  internalizeDocumentAssets,
  loadStoredDocument,
  parseIncomingDocument,
  withUpdatedAt,
} from '../documents.ts';
import { HttpError, notFound, schemaErrorToHttp } from '../errors.ts';
import { sendPortableFile } from './projects.ts';
import { sendThumbnail, storeThumbnail, thumbnailUrl } from './thumbnails.ts';

const EPOCH = '1970-01-01T00:00:00.000Z';

interface TemplateListRow {
  id: string;
  title: string;
  category: string | null;
  size: PageSize;
  page_count: number;
  slot_count: number;
  built_in: boolean;
  updated_at: Date;
  thumbnail_updated_at: Date | null;
}

/** Item of GET /api/templates. */
export interface TemplateListItem {
  id: string;
  title: string;
  category: string | null;
  size: PageSize;
  pageCount: number;
  slotCount: number;
  thumbnailUrl: string | null;
  builtIn: boolean;
  updatedAt: string;
}

/** Throws 400 not_a_template unless kind === 'template'. */
export function requireTemplateKind(doc: PlakatDocument): void {
  if (doc.kind !== 'template' || !doc.template) {
    throw new HttpError(400, 'not_a_template', 'Expected a document with kind "template"');
  }
}

async function prepare(ctx: AppContext, doc: PlakatDocument, id?: string): Promise<PlakatDocument> {
  requireTemplateKind(doc);
  const now = ctx.now();
  if (id) doc = { ...doc, id };
  if (doc.meta.createdAt === EPOCH) doc = { ...doc, meta: { ...doc.meta, createdAt: now.toISOString() } };
  return internalizeDocumentAssets(withUpdatedAt(doc, now), ctx.uploads);
}

/** Inserts a user template; a taken id is replaced by a fresh one. */
async function insertTemplate(ctx: AppContext, input: PlakatDocument) {
  let doc = input;
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = documentSummary(doc);
    const { rows } = await ctx.db.query<{ updated_at: Date; version: number }>(
      `INSERT INTO templates (id, title, category, document, schema_version, version, built_in, search_text, size, page_count, slot_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 1, false, $6, $7::jsonb, $8, $9, $10, $10)
       ON CONFLICT (id) DO NOTHING
       RETURNING updated_at, version`,
      [doc.id, s.title, s.category, JSON.stringify(doc), s.schemaVersion, s.searchText, JSON.stringify(s.size), s.pageCount, s.slotCount, doc.meta.updatedAt],
    );
    const row = rows[0];
    if (row) return { id: doc.id, document: doc, builtIn: false, version: row.version, updatedAt: toIso(row.updated_at) };
    doc = { ...doc, id: createId('doc') };
  }
  throw new HttpError(500, 'internal_error', 'Could not allocate a template id');
}

async function getBuiltIn(ctx: AppContext, id: string): Promise<boolean> {
  const { rows } = await ctx.db.query<{ built_in: boolean }>('SELECT built_in FROM templates WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Template');
  return rows[0].built_in;
}

export function registerTemplateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/templates', async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const category = typeof query['category'] === 'string' ? query['category'].trim().slice(0, 200) : '';
    const q = typeof query['q'] === 'string' ? query['q'].trim().toLowerCase().slice(0, 200) : '';
    const where: string[] = [];
    const params: unknown[] = [];
    if (category) {
      params.push(category, `${escapeLike(category)}/%`);
      where.push(`(category = $${params.length - 1} OR category LIKE $${params.length} ESCAPE '\\')`);
    }
    if (q) {
      for (const term of q.split(/\s+/).slice(0, 8)) {
        params.push(`%${escapeLike(term)}%`);
        where.push(`search_text LIKE $${params.length} ESCAPE '\\'`);
      }
    }
    const { rows } = await db.query<TemplateListRow>(
      `SELECT id, title, category, size, page_count, slot_count, built_in, updated_at, thumbnail_updated_at
       FROM templates ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY built_in ASC, CASE WHEN built_in THEN title END ASC, updated_at DESC, id`,
      params,
    );
    const items: TemplateListItem[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      size: r.size,
      pageCount: r.page_count,
      slotCount: r.slot_count,
      thumbnailUrl: thumbnailUrl('templates', r.id, r.thumbnail_updated_at),
      builtIn: r.built_in,
      updatedAt: toIso(r.updated_at),
    }));
    return { items };
  });

  app.post('/api/templates/import', async (req, reply) => {
    let doc: PlakatDocument;
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      try {
        doc = parseDocument(req.body.toString());
      } catch (error) {
        throw schemaErrorToHttp(error) ?? error;
      }
    } else {
      doc = parseIncomingDocument(req.body);
    }
    return reply.code(201).send(await insertTemplate(ctx, await prepare(ctx, doc)));
  });

  app.post('/api/templates', async (req, reply) => {
    const doc = await prepare(ctx, parseIncomingDocument(bodyField(req.body, 'document')));
    return reply.code(201).send(await insertTemplate(ctx, doc));
  });

  app.get('/api/templates/:id', async (req) => {
    const id = idParam(req.params, 'Template');
    const { rows } = await db.query<{ document: unknown; built_in: boolean; version: number; updated_at: Date }>(
      'SELECT document, built_in, version, updated_at FROM templates WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) throw notFound('Template');
    return { id, document: loadStoredDocument(row.document), builtIn: row.built_in, version: row.version, updatedAt: toIso(row.updated_at) };
  });

  app.put('/api/templates/:id', async (req) => {
    const id = idParam(req.params, 'Template');
    if (await getBuiltIn(ctx, id)) throw new HttpError(403, 'built_in_template', 'Built-in templates cannot be modified; save a copy instead');
    const body = req.body as Record<string, unknown> | null;
    const baseVersion = body && Object.hasOwn(body, 'baseVersion') ? body['baseVersion'] : undefined;
    if (baseVersion !== undefined && (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 1)) {
      throw new HttpError(400, 'bad_request', '"baseVersion" must be a positive integer');
    }
    const doc = await prepare(ctx, parseIncomingDocument(bodyField(req.body, 'document')), id);
    const s = documentSummary(doc);
    const { rows } = await db.query<{ version: number; updated_at: Date }>(
      `UPDATE templates SET title = $3, category = $4, document = $5::jsonb, schema_version = $6, search_text = $7, size = $8::jsonb,
              page_count = $9, slot_count = $10, version = version + 1, updated_at = $11
       WHERE id = $1 AND built_in = false AND ($2::int IS NULL OR version = $2::int)
       RETURNING version, updated_at`,
      [id, baseVersion ?? null, s.title, s.category, JSON.stringify(doc), s.schemaVersion, s.searchText, JSON.stringify(s.size), s.pageCount, s.slotCount, doc.meta.updatedAt],
    );
    const row = rows[0];
    if (!row) {
      const cur = await db.query<{ version: number }>('SELECT version FROM templates WHERE id = $1', [id]);
      if (!cur.rows[0]) throw notFound('Template');
      throw new HttpError(409, 'version_conflict', 'The template was changed elsewhere', { currentVersion: cur.rows[0].version });
    }
    return { id, version: row.version, updatedAt: toIso(row.updated_at) };
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const id = idParam(req.params, 'Template');
    if (await getBuiltIn(ctx, id)) throw new HttpError(403, 'built_in_template', 'Built-in templates cannot be deleted');
    await db.query('DELETE FROM templates WHERE id = $1 AND built_in = false', [id]);
    return reply.code(204).send();
  });

  app.get('/api/templates/:id/file', async (req, reply) => {
    const id = idParam(req.params, 'Template');
    const { rows } = await db.query<{ document: unknown }>('SELECT document FROM templates WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Template');
    const doc = await bundleDocumentForExport(loadStoredDocument(rows[0].document), ctx.uploads);
    return sendPortableFile(reply, doc);
  });

  app.put('/api/templates/:id/thumbnail', async (req) => {
    const id = idParam(req.params, 'Template');
    return { thumbnailUrl: await storeThumbnail(ctx, 'templates', id, req.body) };
  });

  app.get('/api/templates/:id/thumbnail', async (req, reply) => {
    return sendThumbnail(ctx, 'templates', idParam(req.params, 'Template'), req, reply);
  });
}
