import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig, REPO_ROOT } from './config.ts';

// Optional .env (cwd first, then repo root). Never overrides variables already set.
for (const file of new Set([path.resolve('.env'), path.join(REPO_ROOT, '.env')])) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Plakat server ready (${app.plakat.db.kind}${config.databaseUrl ? '' : `: ${config.pglite}`})${config.publicUrl ? ` at ${config.publicUrl}` : ''}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
