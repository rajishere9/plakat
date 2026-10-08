import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Raw JSON of docs' worked example (packages/schema/src/__fixtures__/example.plakat.json). */
export function readExampleJson(): Record<string, unknown> {
  const path = fileURLToPath(new URL('./__fixtures__/example.plakat.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

export const FIXED_NOW = () => new Date('2026-10-08T12:00:00.000Z');
