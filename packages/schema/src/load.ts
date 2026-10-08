import type { PlakatDocument } from './types.ts';
import { DocumentSchema, findReservedKey, toValidationIssues, type ValidationIssue } from './validation.ts';
import { migrateDocument, MigrationError, UnsupportedSchemaVersionError, type MigrateOptions } from './version.ts';

export class DocumentValidationError extends Error {
  override name = 'DocumentValidationError';
  constructor(readonly issues: ValidationIssue[]) {
    super(
      `Invalid Plakat document:\n` +
        issues
          .slice(0, 20)
          .map((i) => `  - ${i.path}: ${i.message}`)
          .join('\n') +
        (issues.length > 20 ? `\n  ... and ${issues.length - 20} more` : ''),
    );
  }
}

export type LoadResult =
  | { ok: true; document: PlakatDocument; fromVersion: number; migrated: boolean }
  | { ok: false; error: DocumentValidationError | MigrationError | UnsupportedSchemaVersionError };

/**
 * The ONLY sanctioned way to turn untrusted JSON (files, API bodies, DB rows) into a
 * PlakatDocument: migrate to the current schemaVersion, then validate strictly
 * (unknown keys rejected, defaults filled, cross-references checked).
 */
export function loadDocument(input: unknown, options?: MigrateOptions): PlakatDocument {
  const result = safeLoadDocument(input, options);
  if (!result.ok) throw result.error;
  return result.document;
}

export function safeLoadDocument(input: unknown, options?: MigrateOptions): LoadResult {
  let migrated;
  try {
    migrated = migrateDocument(input, options);
  } catch (error) {
    if (error instanceof MigrationError || error instanceof UnsupportedSchemaVersionError) return { ok: false, error };
    throw error;
  }
  const parsed = parseStrict(migrated.document);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    document: parsed.data,
    fromVersion: migrated.fromVersion,
    migrated: migrated.applied.length > 0,
  };
}

/** Validates an in-memory document without migrating (e.g. before saving). Throws DocumentValidationError. */
export function assertValidDocument(doc: unknown): asserts doc is PlakatDocument {
  const parsed = parseStrict(doc);
  if (!parsed.ok) throw parsed.error;
}

function parseStrict(input: unknown): { ok: true; data: PlakatDocument } | { ok: false; error: DocumentValidationError } {
  const reserved = findReservedKey(input);
  if (reserved) {
    return { ok: false, error: new DocumentValidationError([{ path: reserved, message: 'Reserved key (__proto__, constructor and prototype are not allowed)' }]) };
  }
  const parsed = DocumentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: new DocumentValidationError(toValidationIssues(parsed.error)) };
  return { ok: true, data: parsed.data };
}
