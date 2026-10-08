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

/** Maps @plakat/schema load errors to 400 (invalid) / 422 (unsupported version). */
export function schemaErrorToHttp(error: unknown): HttpError | null {
  if (error instanceof DocumentValidationError) {
    return new HttpError(400, 'invalid_document', 'The document failed validation', { issues: error.issues.slice(0, 100) });
  }
  if (error instanceof UnsupportedSchemaVersionError) {
    return new HttpError(422, 'unsupported_schema_version', error.message, { found: error.found, supported: error.supported });
  }
  if (error instanceof MigrationError) {
    return new HttpError(400, 'invalid_document', error.message, { issues: [{ path: '(root)', message: error.message }] });
  }
  return null;
}
