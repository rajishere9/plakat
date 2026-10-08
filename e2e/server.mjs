#!/usr/bin/env node
// Playwright webServer for the e2e suite: serves the built SPA (apps/web/dist, built
// first when missing or when PLAKAT_E2E_BUILD=1) from the real API server, with a
// throwaway in-memory PGlite database and a fresh upload directory per run.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/web/dist');

if (process.env.PLAKAT_E2E_BUILD === '1' || !existsSync(path.join(dist, 'index.html'))) {
  console.log('[e2e-server] building apps/web …');
  const r = spawnSync('npm', ['run', 'build', '-w', '@plakat/web'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'plakat-e2e-'));
const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'apps/server/src/index.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PLAKAT_E2E_PORT ?? '8791',
    HOST: '127.0.0.1',
    PGLITE: 'memory',
    DATABASE_URL: '',
    DATA_DIR: dataDir,
    WEB_DIST: dist,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  },
});

const cleanup = () => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};
child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
