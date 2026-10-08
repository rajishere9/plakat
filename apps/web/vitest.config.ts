import { defineConfig } from 'vitest/config';

/**
 * Web app tests. Picked up by a root `test.projects` config if one exists; when run
 * without it (`npx vitest run apps/web` from the repo root), files that need a DOM
 * declare `// @vitest-environment jsdom` themselves, so both ways work.
 */
export default defineConfig({
  test: {
    name: 'web',
    root: import.meta.dirname,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
