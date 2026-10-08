import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';

/**
 * CSP for served SVGs: no scripts, no external loads; inline styles only. `form-action`
 * and navigation do not fall back to default-src, so `sandbox` (unique origin, no forms,
 * no scripts, no top navigation) stops an SVG opened directly from posing as a
 * same-origin sign-in page. <img> rendering is unaffected.
 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; sandbox";

export function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { uploads } = ctx;

  app.post('/api/uploads', async (req, reply) => {
    if (!req.isMultipart()) throw new HttpError(415, 'unsupported_media_type', 'Send the file as multipart/form-data (field "file")');
    const part = await req.file({ limits: { fileSize: ctx.config.maxUploadBytes, files: 1 } });
    if (!part) throw new HttpError(400, 'bad_request', 'Missing file field "file"');
    if (part.fieldname !== 'file') {
      part.file.resume();
      throw new HttpError(400, 'bad_request', 'The file must be sent in the multipart field "file"');
    }
    const bytes = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE (413) past the limit
    const stored = await uploads.store(bytes, { filename: part.filename });
    return reply.code(201).send(stored);
  });

  const serve = async (file: string, req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const p = uploads.pathFor(file);
    const mime = uploads.mimeFor(file);
    if (!p || !mime) throw notFound('File');
    let size: number;
    try {
      const st = await stat(p);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      throw notFound('File');
    }
    const etag = `"${file.slice(0, 64)}"`;
    reply
      .header('Content-Type', mime)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cross-Origin-Resource-Policy', 'cross-origin');
    if (mime === 'image/svg+xml') reply.header('Content-Security-Policy', SVG_CSP);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('Content-Length', String(size));
    return reply.send(createReadStream(p));
  };

  app.get('/uploads/:file', async (req, reply) => serve(String((req.params as { file?: unknown }).file ?? ''), req, reply));
}
