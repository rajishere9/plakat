import { createId, loadBrandKit, type BrandKit } from '@plakat/schema';
import type { FastifyInstance } from 'fastify';
import { bodyField, idParam, type AppContext } from '../context.ts';
import { internalizeAssets, sanitizeJsonStrings } from '../documents.ts';
import { HttpError, notFound, schemaErrorToHttp } from '../errors.ts';

function parseKit(input: unknown): BrandKit {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'invalid_brand_kit', 'Expected a brand kit object');
  }
  try {
    return loadBrandKit(sanitizeJsonStrings(input));
  } catch (error) {
    const http = schemaErrorToHttp(error);
    if (http) throw new HttpError(http.statusCode, http.statusCode === 400 ? 'invalid_brand_kit' : http.code, http.message, http.extra);
    throw error;
  }
}

async function prepare(ctx: AppContext, raw: unknown, id?: string): Promise<BrandKit> {
  const kit = parseKit(raw);
  return { ...kit, id: id ?? kit.id, assets: await internalizeAssets(kit.assets, ctx.uploads, { remote: ctx.remoteAssets }) };
}

export function registerBrandKitRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/brand-kits', async () => {
    const { rows } = await db.query<{ kit: unknown }>('SELECT kit FROM brand_kits ORDER BY updated_at DESC, id');
    return { items: rows.map((r) => loadBrandKit(r.kit)) };
  });

  app.post('/api/brand-kits', async (req, reply) => {
    let kit = await prepare(ctx, bodyField(req.body, 'kit'));
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await db.query(
        `INSERT INTO brand_kits (id, name, kit) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [kit.id, kit.name, JSON.stringify(kit)],
      );
      if (rows[0]) return reply.code(201).send({ kit });
      kit = { ...kit, id: createId('bk') };
    }
    throw new HttpError(500, 'internal_error', 'Could not allocate a brand kit id');
  });

  app.get('/api/brand-kits/:id', async (req) => {
    const id = idParam(req.params, 'Brand kit');
    const { rows } = await db.query<{ kit: unknown }>('SELECT kit FROM brand_kits WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Brand kit');
    return { kit: loadBrandKit(rows[0].kit) };
  });

  app.put('/api/brand-kits/:id', async (req) => {
    const id = idParam(req.params, 'Brand kit');
    const kit = await prepare(ctx, bodyField(req.body, 'kit'), id);
    const { rows } = await db.query(
      `UPDATE brand_kits SET name = $2, kit = $3::jsonb, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, kit.name, JSON.stringify(kit)],
    );
    if (!rows[0]) throw notFound('Brand kit');
    return { kit };
  });

  app.delete('/api/brand-kits/:id', async (req, reply) => {
    const id = idParam(req.params, 'Brand kit');
    const { rows } = await db.query('DELETE FROM brand_kits WHERE id = $1 RETURNING id', [id]);
    if (!rows[0]) throw notFound('Brand kit');
    return reply.code(204).send();
  });
}
