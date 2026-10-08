import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'templates',
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
