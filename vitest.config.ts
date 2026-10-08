import { defineConfig } from 'vitest/config';

/**
 * Root test entry: `npm test` runs every unit suite, each with its own environment
 * (node for schema/renderer/server/templates, jsdom for the web app). Each project's
 * settings live in its own vitest.config.ts. Playwright e2e specs (e2e/) are separate:
 * `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/schema/vitest.config.ts',
      'packages/renderer/vitest.config.ts',
      'apps/server/vitest.config.ts',
      'apps/web/vitest.config.ts',
      'templates/vitest.config.ts',
    ],
  },
});
