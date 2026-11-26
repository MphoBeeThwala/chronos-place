import type { GraphQLFormattedError } from 'graphql';

/** Error codes clients may see. Anything else becomes a generic internal error. */
export const CLIENT_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'BAD_USER_INPUT',
  'NOT_AVAILABLE',
  'RATE_LIMITED',
  'FAILED_PRECONDITION',
  'VERIFICATION_REQUIRED',
  'PROFILE_REQUIRED',
  'NOT_FOUND',
  'UNAVAILABLE',
  'REFRESH_IN_PROGRESS',
  // A newer save from another device (M2.8): reload and try again.
  'CONFLICT',
  'PERSISTED_QUERY_NOT_FOUND',
]);

/**
 * Parse and validation messages can quote literal values from the query, which could be a phone
 * number or a code. They keep their code but lose their text (CLAUDE.md rule 3).
 */
const QUERY_ERROR_CODES = new Set([
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_REQUEST',
]);

/** Apollo prefixes errors thrown while the request context is built (rate limits, approval). */
const CONTEXT_PREFIX = 'Context creation failed: ';

export function formatError(formatted: GraphQLFormattedError): GraphQLFormattedError {
  const message = formatted.message.startsWith(CONTEXT_PREFIX)
    ? formatted.message.slice(CONTEXT_PREFIX.length)
    : formatted.message;
  const code =
    typeof formatted.extensions?.['code'] === 'string' ? formatted.extensions['code'] : '';
  if (CLIENT_CODES.has(code)) {
    const retryAfter = formatted.extensions?.['retryAfterSeconds'];
    return {
      message,
      extensions: {
        code,
        ...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {}),
      },
    };
  }
  if (QUERY_ERROR_CODES.has(code)) return { message: 'Invalid request.', extensions: { code } };
  return { message: 'Something went wrong.', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
}
