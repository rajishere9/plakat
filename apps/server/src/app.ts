import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { OpenverseProvider } from './assets/openverse.ts';
import { ProviderRegistry, type AssetProvider } from './assets/provider.ts';
import type { Config } from './config.ts';
import type { AppContext } from './context.ts';
import { createDb, runMigrations, type Db } from './db/index.ts';
import { HttpError, schemaErrorToHttp } from './errors.ts';
import { dnsResolver, type HostResolver } from './net/safeFetch.ts';
import { registerAssetRoutes } from './routes/assets.ts';
import { registerBrandKitRoutes } from './routes/brandKits.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerUploadRoutes } from './routes/uploads.ts';
import { UploadStore } from './storage/uploads.ts';
import { seedBuiltInTemplates, type SeedResult } from './templates/seed.ts';

export interface BuildAppOptions {
  /** Use this database instead of creating one from config (it is NOT closed on app.close()). */
  db?: Db;
  /** fetch used by asset providers and image downloads (tests inject a mock). */
  fetch?: typeof fetch;
  /** DNS resolver for the SSRF guard (tests inject a fake). */
  resolveHost?: HostResolver;
  /** Replaces the default provider list ([Openverse]). */
  providers?: AssetProvider[];
  /** Fastify logger option (default: pino at config.logLevel; tests pass false). */
  logger?: FastifyServerOptions['logger'];
  /** Seed built-in templates from config.templatesDir on startup (default true). */
  seedTemplates?: boolean;
  /** Clock override (tests). */
  now?: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    plakat: AppContext & { seed: SeedResult | null };
  }
}

const FASTIFY_CODES: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_REQ_FILE_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'bad_request',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_json',
  FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_json',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'unsupported_media_type',
  FST_FILES_LIMIT: 'bad_request',
  FST_PARTS_LIMIT: 'bad_request',
};

/**
 * Builds the Plakat API server: connects the database (pg if DATABASE_URL, else
 * PGlite), applies migrations, seeds built-in templates and registers all routes.
 * Call `app.listen()` yourself, or use `app.inject()` in tests.
 */
export async function buildApp(config: Config, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const ownsDb = !options.db;
  const db = options.db ?? (await createDb(config));
  await runMigrations(db);

  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    bodyLimit: config.maxBodyBytes,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    trustProxy: true,
  });

  const uploads = new UploadStore(db, config.uploadDir, config.maxUploadBytes);
  await uploads.init();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const providers = new ProviderRegistry(
    options.providers ?? [
      new OpenverseProvider({
        apiBase: config.openverse.apiBase,
        clientId: config.openverse.clientId,
        clientSecret: config.openverse.clientSecret,
        fetch: fetchImpl,
      }),
    ],
  );
  const ctx: AppContext = {
    config,
    db,
    uploads,
    providers,
    fetch: fetchImpl,
    resolveHost: options.resolveHost ?? dnsResolver,
    now: options.now ?? (() => new Date()),
  };

  let seed: SeedResult | null = null;
  if (options.seedTemplates !== false) {
    seed = await seedBuiltInTemplates(db, uploads, config.templatesDir, {
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
    });
  }
  app.decorate('plakat', { ...ctx, seed });

  if (ownsDb) app.addHook('onClose', async () => db.close());

  // ---- Parsers -----------------------------------------------------------
  app.addContentTypeParser('image/png', { parseAs: 'buffer', bodyLimit: config.maxThumbnailBytes }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/vnd.plakat+json', { parseAs: 'string' }, app.getDefaultJsonParser('error', 'error'));
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10, parts: 20, fieldSize: 64 * 1024 },
  });
  if (config.corsOrigin) {
    await app.register(fastifyCors, { origin: config.corsOrigin.split(',').map((s) => s.trim()) });
  }

  // ---- Errors --------------------------------------------------------------
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send(error.toBody());
    const schemaError = schemaErrorToHttp(error);
    if (schemaError) return reply.code(schemaError.statusCode).send(schemaError.toBody());
    if (error.validation) return reply.code(400).send({ error: { code: 'bad_request', message: error.message } });
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'request failed');
      return reply.code(status).send({ error: { code: 'internal_error', message: 'Internal server error' } });
    }
    const code = (error.code && FASTIFY_CODES[error.code]) ?? (/proto|constructor/i.test(error.message) ? 'invalid_json' : 'bad_request');
    return reply.code(status).send({ error: { code, message: error.message } });
  });

  // ---- Routes ---------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, db: db.kind }));
  registerProjectRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  registerBrandKitRoutes(app, ctx);
  registerUploadRoutes(app, ctx);
  registerAssetRoutes(app, ctx);

  // ---- SPA ------------------------------------------------------------------
  const webDist = config.webDist;
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      setHeaders(reply, filePath) {
        if (filePath.endsWith('index.html')) reply.header('Cache-Control', 'no-cache');
        else if (/[\\/]assets[\\/]/.test(filePath)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    const isApi = url.startsWith('/api/') || url === '/api' || url.startsWith('/uploads/');
    if (webDist && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${url} not found` } });
  });

  return app;
}
