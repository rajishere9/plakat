import { createId, PORTABLE_MIME_TYPE, serializeDocument, type PageSize, type PlakatDocument } from '@plakat/schema';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { bodyField, idParam, toIso, type AppContext } from '../context.ts';
import {
  bundleDocumentForExport,
  documentSummary,
  internalizeDocumentAssets,
  loadStoredDocument,
  parseIncomingDocument,
  slugify,
  withUpdatedAt,
} from '../documents.ts';
import { HttpError, notFound } from '../errors.ts';
import { sendThumbnail, storeThumbnail, thumbnailUrl } from './thumbnails.ts';

const EPOCH = '1970-01-01T00:00:00.000Z';

interface ProjectListRow {
  id: string;
  title: string;
  size: PageSize;
  page_count: number;
  updated_at: Date;
  thumbnail_updated_at: Date | null;
}

/** Item of GET /api/projects. */
export interface ProjectListItem {
  id: string;
  title: string;
  updatedAt: string;
  size: PageSize;
  pageCount: number;
  thumbnailUrl: string | null;
}

/** Validates + canonicalizes an incoming design and applies server-owned fields. */
async function prepare(ctx: AppContext, raw: unknown, id?: string): Promise<PlakatDocument> {
  let doc = parseIncomingDocument(raw);
  const now = ctx.now();
  if (id) doc = { ...doc, id };
  if (doc.meta.createdAt === EPOCH) doc = { ...doc, meta: { ...doc.meta, createdAt: now.toISOString() } };
  doc = withUpdatedAt(doc, now);
  return internalizeDocumentAssets(doc, ctx.uploads, { remote: ctx.remoteAssets });
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/projects', async () => {
    const { rows } = await db.query<ProjectListRow>(
      'SELECT id, title, size, page_count, updated_at, thumbnail_updated_at FROM projects ORDER BY updated_at DESC, id',
    );
    const items: ProjectListItem[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: toIso(r.updated_at),
      size: r.size,
      pageCount: r.page_count,
      thumbnailUrl: thumbnailUrl('projects', r.id, r.thumbnail_updated_at),
    }));
    return { items };
  });

  app.post('/api/projects', async (req, reply) => {
    let doc = await prepare(ctx, bodyField(req.body, 'document'));
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = documentSummary(doc);
      const { rows } = await db.query<{ version: number; updated_at: Date }>(
        `INSERT INTO projects (id, title, document, schema_version, version, size, page_count, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, 1, $5::jsonb, $6, $7, $7)
         ON CONFLICT (id) DO NOTHING
         RETURNING version, updated_at`,
        [doc.id, s.title, JSON.stringify(doc), s.schemaVersion, JSON.stringify(s.size), s.pageCount, doc.meta.updatedAt],
      );
      const row = rows[0];
      if (row) {
        return reply.code(201).send({ id: doc.id, document: doc, version: row.version, updatedAt: toIso(row.updated_at) });
      }
      // Id taken (e.g. a duplicated/imported file): store under a fresh id.
      doc = { ...doc, id: createId('doc') };
    }
    throw new HttpError(500, 'internal_error', 'Could not allocate a project id');
  });

  app.get('/api/projects/:id', async (req) => {
    const id = idParam(req.params, 'Project');
    const { rows } = await db.query<{ document: unknown; version: number; updated_at: Date }>(
      'SELECT document, version, updated_at FROM projects WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) throw notFound('Project');
    return { id, document: loadStoredDocument(row.document), version: row.version, updatedAt: toIso(row.updated_at) };
  });

  app.put('/api/projects/:id', async (req) => {
    const id = idParam(req.params, 'Project');
    const baseVersion = bodyField(req.body, 'baseVersion');
    if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 1) {
      throw new HttpError(400, 'bad_request', '"baseVersion" must be a positive integer');
    }
    const doc = await prepare(ctx, bodyField(req.body, 'document'), id);
    const s = documentSummary(doc);
    const { rows } = await db.query<{ version: number; updated_at: Date }>(
      `UPDATE projects SET title = $3, document = $4::jsonb, schema_version = $5, size = $6::jsonb, page_count = $7,
              version = version + 1, updated_at = $8
       WHERE id = $1 AND version = $2
       RETURNING version, updated_at`,
      [id, baseVersion, s.title, JSON.stringify(doc), s.schemaVersion, JSON.stringify(s.size), s.pageCount, doc.meta.updatedAt],
    );
    const row = rows[0];
    if (row) return { id, version: row.version, updatedAt: toIso(row.updated_at) };
    const current = await db.query<{ version: number }>('SELECT version FROM projects WHERE id = $1', [id]);
    const cur = current.rows[0];
    if (!cur) throw notFound('Project');
    throw new HttpError(409, 'version_conflict', `The project was changed elsewhere (current version ${cur.version}, yours ${baseVersion})`, {
      currentVersion: cur.version,
    });
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const id = idParam(req.params, 'Project');
    const { rows } = await db.query('DELETE FROM projects WHERE id = $1 RETURNING id', [id]);
    if (!rows[0]) throw notFound('Project');
    return reply.code(204).send();
  });

  app.put('/api/projects/:id/thumbnail', async (req) => {
    const id = idParam(req.params, 'Project');
    return { thumbnailUrl: await storeThumbnail(ctx, 'projects', id, req.body) };
  });

  app.get('/api/projects/:id/thumbnail', async (req, reply) => {
    return sendThumbnail(ctx, 'projects', idParam(req.params, 'Project'), req, reply);
  });

  /** Extra: portable .plakat.json download of a design (assets bundled as data URIs). */
  app.get('/api/projects/:id/file', async (req, reply) => {
    const id = idParam(req.params, 'Project');
    const { rows } = await db.query<{ document: unknown }>('SELECT document FROM projects WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Project');
    const doc = await bundleDocumentForExport(loadStoredDocument(rows[0].document), ctx.uploads);
    return sendPortableFile(reply, doc);
  });
}

export function sendPortableFile(reply: FastifyReply, doc: PlakatDocument) {
  const filename = `${slugify(doc.meta.title)}.plakat.json`;
  return reply
    .header('Content-Type', `${PORTABLE_MIME_TYPE}; charset=utf-8`)
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Cache-Control', 'no-store')
    .send(serializeDocument(doc));
}
