import { defineConfig } from 'vitest/config';

// @plakat/renderer tests run under Node with konva/canvas-backend + node-canvas
// (render-export-pipeline.md §6.1). Rendering print-size pages is slow-ish, so the
// timeouts are generous; test files also set per-test timeouts so they pass when
// run through a root config that does not load this file.
export default defineConfig({
  test: {
    name: 'renderer',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
