import { DOCUMENT_FORMAT } from './types.ts';

/**
 * Monotonic integer. Bumped for EVERY change to the persisted format
 * (additions included). Each bump ships a migration `n -> n + 1`.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export type JsonObject = Record<string, unknown>;

export interface Migration {
  /** Upgrades a document at `from` to `from + 1`. */
  from: number;
  description: string;
  /** Pure function on untyped JSON. Must not mutate its input. Must not consult the clock or randomness. */
  migrate: (doc: JsonObject) => JsonObject;
}

export class UnsupportedSchemaVersionError extends Error {
  override name = 'UnsupportedSchemaVersionError';
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This file uses Plakat document schemaVersion ${found}, but this Plakat build supports up to ${supported}. ` +
        'Upgrade Plakat to open it.',
    );
  }
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * v0 = "loose" unversioned documents: JSON objects with `pages` but no `schemaVersion`
 * (hand-written files, pre-release prototypes). The migration stamps the envelope
 * and folds a top-level `width`/`height` (prototype layout) into `size`.
 */
export const migrateV0ToV1: Migration = {
  from: 0,
  description: 'Stamp format/schemaVersion on unversioned documents; fold top-level width/height into size',
  migrate(doc) {
    const { width, height, version: _legacyVersion, ...rest } = doc;
    const out: JsonObject = { ...rest, format: DOCUMENT_FORMAT, schemaVersion: 1 };
    if (out['size'] === undefined && typeof width === 'number' && typeof height === 'number') {
      out['size'] = { width, height, presetId: null, physical: null };
    }
    return out;
  },
};

/** The production migration chain. Index i upgrades version i -> i + 1. */
export const MIGRATIONS: readonly Migration[] = [migrateV0ToV1];

/**
 * Reads the schema version of untrusted JSON.
 * Missing `schemaVersion` => 0. Non-integer / negative => MigrationError.
 */
export function getSchemaVersion(input: unknown): number {
  if (!isObject(input)) throw new MigrationError('A Plakat document must be a JSON object');
  const v = input['schemaVersion'];
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new MigrationError(`Invalid schemaVersion: ${JSON.stringify(v)}`);
  }
  return v;
}

export interface MigrateOptions {
  /** Defaults to MIGRATIONS (injectable for tests). */
  migrations?: readonly Migration[];
  /** Defaults to CURRENT_SCHEMA_VERSION. */
  targetVersion?: number;
}

export interface MigrateResult {
  /** Untyped JSON at `toVersion`; NOT yet validated. */
  document: JsonObject;
  fromVersion: number;
  toVersion: number;
  /** Descriptions of the migrations applied, in order. */
  applied: string[];
}

/**
 * Upgrades untrusted JSON to `targetVersion` by applying `from -> from + 1` steps in order.
 * - Newer than target: throws UnsupportedSchemaVersionError (never guesses).
 * - A gap in the chain: throws MigrationError.
 * - A `format` other than "plakat.document": throws MigrationError.
 */
export function migrateDocument(input: unknown, options: MigrateOptions = {}): MigrateResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const target = options.targetVersion ?? CURRENT_SCHEMA_VERSION;
  const fromVersion = getSchemaVersion(input);
  const obj = input as JsonObject;

  const format = obj['format'];
  if (format !== undefined && format !== DOCUMENT_FORMAT) {
    throw new MigrationError(`Not a Plakat document (format: ${JSON.stringify(format)})`);
  }
  if (fromVersion > target) throw new UnsupportedSchemaVersionError(fromVersion, target);

  let doc: JsonObject = structuredClone(obj);
  const applied: string[] = [];
  for (let v = fromVersion; v < target; v++) {
    const step = migrations.find((m) => m.from === v);
    if (!step) throw new MigrationError(`No migration registered from schemaVersion ${v} to ${v + 1}`);
    const next = step.migrate(doc);
    if (!isObject(next)) throw new MigrationError(`Migration ${v} -> ${v + 1} did not return an object`);
    doc = { ...next, schemaVersion: v + 1 };
    applied.push(`${v} -> ${v + 1}: ${step.description}`);
  }
  return { document: doc, fromVersion, toVersion: target, applied };
}
