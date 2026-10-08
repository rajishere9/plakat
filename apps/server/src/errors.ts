import { DocumentValidationError, MigrationError, UnsupportedSchemaVersionError, type ValidationIssue } from '@plakat/schema';

/** Error envelope: `{ error: { code, message, issues?, ...extra } }`. */
export interface ApiErrorBody {
  error: { code: string; message: string; issues?: ValidationIssue[]; [k: string]: unknown };
}

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: { issues?: ValidationIssue[]; [k: string]: unknown } = {},
  ) {
    super(message);
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);

/**
 * Maps @plakat/schema load errors to 400: invalid documents, failed migrations and files
 * from a newer Plakat (`unsupported_schema_version`, with `found`/`supported` and an
 * "upgrade Plakat" message). A RangeError thrown while loading (e.g. a pathological input
 * exhausting the stack) is also the client's input, so 400 rather than 500.
 */
export function schemaErrorToHttp(error: unknown): HttpError | null {
  if (error instanceof DocumentValidationError) {
    return new HttpError(400, 'invalid_document', 'The document failed validation', { issues: error.issues.slice(0, 100) });
  }
  if (error instanceof UnsupportedSchemaVersionError) {
    return new HttpError(400, 'unsupported_schema_version', error.message, { found: error.found, supported: error.supported });
  }
  if (error instanceof MigrationError) {
    return new HttpError(400, 'invalid_document', error.message, { issues: [{ path: '(root)', message: error.message }] });
  }
  if (error instanceof RangeError) {
    const message = 'The document is too large or too deeply nested to process';
    return new HttpError(400, 'invalid_document', message, { issues: [{ path: '(root)', message }] });
  }
  return null;
}
