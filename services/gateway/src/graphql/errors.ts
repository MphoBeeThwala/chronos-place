import type { GraphQLFormattedError } from 'graphql';

/** Error codes clients may see. Anything else becomes a generic internal error. */
export const CLIENT_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'BAD_USER_INPUT',
  'NOT_AVAILABLE',
  'RATE_LIMITED',
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

export function formatError(formatted: GraphQLFormattedError): GraphQLFormattedError {
  const code =
    typeof formatted.extensions?.['code'] === 'string' ? formatted.extensions['code'] : '';
  if (CLIENT_CODES.has(code)) {
    const retryAfter = formatted.extensions?.['retryAfterSeconds'];
    return {
      message: formatted.message,
      extensions: {
        code,
        ...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {}),
      },
    };
  }
  if (QUERY_ERROR_CODES.has(code)) return { message: 'Invalid request.', extensions: { code } };
  return { message: 'Something went wrong.', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
}
