import { describe, expect, it } from 'vitest';
import { loadDocument, safeLoadDocument } from './load.ts';
import {
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  migrateDocument,
  MigrationError,
  MIGRATIONS,
  UnsupportedSchemaVersionError,
  type Migration,
} from './version.ts';
import { readExampleJson } from './test-utils.ts';

describe('schema versioning', () => {
  it('has a contiguous production chain ending at CURRENT_SCHEMA_VERSION', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    MIGRATIONS.forEach((m, i) => expect(m.from).toBe(i));
    expect(MIGRATIONS).toHaveLength(CURRENT_SCHEMA_VERSION);
  });

  it('treats missing schemaVersion as v0 and migrates loose files to v1', () => {
    const v0 = {
      id: 'doc_loose',
      width: 1280,
      height: 720,
      pages: [{ id: 'pg_1', elements: [] }],
    };
    expect(getSchemaVersion(v0)).toBe(0);
    const result = safeLoadDocument(v0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fromVersion).toBe(0);
    expect(result.migrated).toBe(true);
    expect(result.document.format).toBe('plakat.document');
    expect(result.document.schemaVersion).toBe(1);
    expect(result.document.size).toEqual({ width: 1280, height: 720, presetId: null, physical: null });
    expect(v0).not.toHaveProperty('schemaVersion'); // input not mutated
  });

  it('is a no-op for current-version documents', () => {
    const json = readExampleJson();
    const r = migrateDocument(json);
    expect(r.applied).toEqual([]);
    expect(r.document).toEqual(json);
    expect(r.document).not.toBe(json);
  });

  it('runs an injected multi-step chain in order (fake v1 -> v2 -> v3)', () => {
    const calls: string[] = [];
    const fake: Migration[] = [
      ...MIGRATIONS,
      {
        from: 1,
        description: 'rename meta.title -> meta.name',
        migrate: (doc) => {
          calls.push('1->2');
          const meta = doc['meta'] as Record<string, unknown>;
          const { title, ...rest } = meta;
          return { ...doc, meta: { ...rest, name: title } };
        },
      },
      {
        from: 2,
        description: 'add meta.locale',
        migrate: (doc) => {
          calls.push('2->3');
          expect(doc['schemaVersion']).toBe(2); // each step sees the version it upgrades from
          return { ...doc, meta: { ...(doc['meta'] as object), locale: 'en' } };
        },
      },
    ];
    const r = migrateDocument(readExampleJson(), { migrations: fake, targetVersion: 3 });
    expect(calls).toEqual(['1->2', '2->3']);
    expect(r.fromVersion).toBe(1);
    expect(r.toVersion).toBe(3);
    expect(r.document['schemaVersion']).toBe(3);
    expect(r.document['meta']).toMatchObject({ name: 'Summer sale — Instagram post', locale: 'en' });
    expect(r.applied).toHaveLength(2);

    // v0 input walks the whole chain
    const r0 = migrateDocument({ id: 'doc_x', pages: [], meta: { title: 't' } }, { migrations: fake, targetVersion: 3 });
    expect(r0.applied.map((a) => a.slice(0, 6))).toEqual(['0 -> 1', '1 -> 2', '2 -> 3']);
  });

  it('refuses files from the future with an actionable error', () => {
    const future = { ...readExampleJson(), schemaVersion: 99 };
    expect(() => loadDocument(future)).toThrow(UnsupportedSchemaVersionError);
    expect(() => loadDocument(future)).toThrow(/schemaVersion 99.*supports up to 1/);
  });

  it('rejects gaps, bad versions and foreign formats', () => {
    expect(() => migrateDocument({ schemaVersion: 0 }, { migrations: [], targetVersion: 1 })).toThrow(/No migration registered from schemaVersion 0/);
    expect(() => getSchemaVersion({ schemaVersion: 1.5 })).toThrow(MigrationError);
    expect(() => getSchemaVersion({ schemaVersion: '1' })).toThrow(MigrationError);
    expect(() => migrateDocument({ format: 'plakat.brandkit', schemaVersion: 1 })).toThrow(/Not a Plakat document/);
  });
});
