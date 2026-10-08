import type { FastifyReply, FastifyRequest } from 'fastify';
import { toBuffer, type AppContext } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { pngSize } from '../images/dimensions.ts';

export type ThumbTable = 'projects' | 'templates';

/** `/api/<table>/<id>/thumbnail?v=<ms>` (cache-busted), or null when there is none. */
export function thumbnailUrl(table: ThumbTable, id: string, updatedAt: Date | string | null | undefined): string | null {
  if (!updatedAt) return null;
  const ms = (updatedAt instanceof Date ? updatedAt : new Date(updatedAt)).getTime();
  return `/api/${table}/${encodeURIComponent(id)}/thumbnail?v=${ms}`;
}

/** Largest accepted thumbnail side in px (clients render at most 480; generous headroom). */
export const THUMBNAIL_MAX_SIDE = 4096;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Valid (color type -> bit depths) pairs of the PNG spec (IHDR). */
const PNG_BIT_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/**
 * Verifies that `body` really is a PNG before it is stored and later served as
 * `image/png`: the 8-byte signature, a first chunk that is a 13-byte IHDR with sane
 * color type / bit depth, and dimensions in 1..THUMBNAIL_MAX_SIDE. Returns the size, or
 * throws 415 (not a PNG) / 422 (unreasonable dimensions).
 */
export function verifyThumbnailPng(body: Uint8Array): { width: number; height: number } {
  const notPng = () => new HttpError(415, 'unsupported_media_type', 'Thumbnail must be a PNG image');
  if (body.byteLength < 33 || !PNG_SIGNATURE.every((v, i) => body[i] === v)) throw notPng();
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (view.getUint32(8) !== 13) throw notPng();
  const size = pngSize(body);
  if (!size) throw notPng();
  const bitDepth = body[24]!;
  const colorType = body[25]!;
  if (!PNG_BIT_DEPTHS[colorType]?.includes(bitDepth)) throw notPng();
  if (size.width < 1 || size.height < 1 || size.width > THUMBNAIL_MAX_SIDE || size.height > THUMBNAIL_MAX_SIDE) {
    throw new HttpError(422, 'invalid_thumbnail', `Thumbnail must be between 1 and ${THUMBNAIL_MAX_SIDE} px per side (got ${size.width}x${size.height})`);
  }
  return size;
}

/**
 * Stores a raw PNG body as the row's thumbnail; returns the new thumbnailUrl. Built-in
 * templates' thumbnails are read-only (403): any client could otherwise replace the
 * gallery image of a template every user sees.
 */
export async function storeThumbnail(ctx: AppContext, table: ThumbTable, id: string, body: unknown): Promise<string> {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the thumbnail as a raw image/png body');
  }
  verifyThumbnailPng(body);
  const guard = table === 'templates' ? ' AND built_in = false' : '';
  const { rows } = await ctx.db.query<{ thumbnail_updated_at: Date }>(
    `UPDATE ${table} SET thumbnail = $2, thumbnail_updated_at = clock_timestamp() WHERE id = $1${guard} RETURNING thumbnail_updated_at`,
    [id, body],
  );
  const row = rows[0];
  if (!row) {
    if (table === 'templates') {
      const existing = await ctx.db.query<{ built_in: boolean }>('SELECT built_in FROM templates WHERE id = $1', [id]);
      if (existing.rows[0]?.built_in) throw new HttpError(403, 'built_in_template', 'Built-in template thumbnails cannot be changed');
    }
    throw notFound(table === 'projects' ? 'Project' : 'Template');
  }
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
