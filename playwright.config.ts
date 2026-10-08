import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

/**
 * Browser e2e (render-export-pipeline.md §6.2). `npm run test:e2e` builds the web app
 * and runs these specs against the real server (e2e/server.mjs: built SPA via WEB_DIST,
 * in-memory PGlite) on PLAKAT_E2E_PORT (default 8791).
 */
const PORT = Number(process.env.PLAKAT_E2E_PORT ?? 8791);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Chromium binary: Playwright's own when installed; otherwise PLAKAT_E2E_CHROMIUM, or
 * the newest chromium headless shell already in the Playwright cache (lets the suite run
 * offline when the cached browser revision is slightly older than @playwright/test's).
 */
function chromiumExecutable(): string | undefined {
  if (process.env.PLAKAT_E2E_CHROMIUM) return process.env.PLAKAT_E2E_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of shells) {
    for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64', 'chrome-mac', 'chrome-linux']) {
      for (const bin of ['chrome-headless-shell', 'headless_shell']) {
        const p = path.join(cache, d, sub, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const executablePath = chromiumExecutable();

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  globalTimeout: 30 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results/e2e',
  use: {
    baseURL: BASE_URL,
    acceptDownloads: true,
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    // Off by default: tracing these pages (large data: URIs, multi-MB downloads) can stall
    // the run for minutes. PLAKAT_E2E_TRACE=1 turns it on for failures.
    trace: process.env.PLAKAT_E2E_TRACE ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        // No device preset: its Windows user agent would make the app pick Ctrl-based
        // shortcuts while Playwright's ControlOrMeta presses Meta on macOS hosts.
        browserName: 'chromium',
        deviceScaleFactor: 1,
        viewport: { width: 1440, height: 900 },
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
