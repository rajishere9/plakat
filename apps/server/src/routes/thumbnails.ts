import type { FastifyReply, FastifyRequest } from 'fastify';
import { toBuffer, type AppContext } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { pngSize, sniffImageType } from '../images/dimensions.ts';

export type ThumbTable = 'projects' | 'templates';

/** `/api/<table>/<id>/thumbnail?v=<ms>` (cache-busted), or null when there is none. */
export function thumbnailUrl(table: ThumbTable, id: string, updatedAt: Date | string | null | undefined): string | null {
  if (!updatedAt) return null;
  const ms = (updatedAt instanceof Date ? updatedAt : new Date(updatedAt)).getTime();
  return `/api/${table}/${encodeURIComponent(id)}/thumbnail?v=${ms}`;
}

/** Stores a raw PNG body as the row's thumbnail; returns the new thumbnailUrl. */
export async function storeThumbnail(ctx: AppContext, table: ThumbTable, id: string, body: unknown): Promise<string> {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the thumbnail as a raw image/png body');
  }
  const size = sniffImageType(body) === 'image/png' ? pngSize(body) : null;
  if (!size || size.width < 1 || size.height < 1) throw new HttpError(415, 'unsupported_media_type', 'Thumbnail must be a PNG image');
  const { rows } = await ctx.db.query<{ thumbnail_updated_at: Date }>(
    `UPDATE ${table} SET thumbnail = $2, thumbnail_updated_at = clock_timestamp() WHERE id = $1 RETURNING thumbnail_updated_at`,
    [id, body],
  );
  const row = rows[0];
  if (!row) throw notFound(table === 'projects' ? 'Project' : 'Template');
  return thumbnailUrl(table, id, row.thumbnail_updated_at)!;
}

export async function sendThumbnail(ctx: AppContext, table: ThumbTable, id: string, req: FastifyRequest, reply: FastifyReply) {
  const { rows } = await ctx.db.query<{ thumbnail: Uint8Array | null }>(`SELECT thumbnail FROM ${table} WHERE id = $1`, [id]);
  const thumb = rows[0]?.thumbnail;
  if (!thumb) throw notFound('Thumbnail');
  const versioned = typeof (req.query as Record<string, unknown> | undefined)?.['v'] === 'string';
  return reply
    .header('Content-Type', 'image/png')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache')
    .send(toBuffer(thumb));
}
