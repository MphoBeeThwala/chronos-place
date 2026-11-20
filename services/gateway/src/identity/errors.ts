import { status } from '@grpc/grpc-js';
import { GraphQLError } from 'graphql';

/**
 * gRPC failures from a service, as GraphQL errors. Only codes for which services send fixed,
 * generic messages pass the message through (identity never says whether a number has an
 * account). Anything else, including connection errors whose text can name hosts, is generic.
 */
const PASS_THROUGH: Partial<Record<number, string>> = {
  [status.INVALID_ARGUMENT]: 'BAD_USER_INPUT',
  [status.UNAUTHENTICATED]: 'UNAUTHENTICATED',
  [status.FAILED_PRECONDITION]: 'FAILED_PRECONDITION',
  [status.RESOURCE_EXHAUSTED]: 'RATE_LIMITED',
};

export function fromGrpc(error: unknown): GraphQLError {
  const grpc = error as { code?: unknown; details?: unknown };
  const code = typeof grpc.code === 'number' ? PASS_THROUGH[grpc.code] : undefined;
  if (code !== undefined && typeof grpc.details === 'string' && grpc.details.length < 200) {
    return new GraphQLError(grpc.details, { extensions: { code } });
  }
  if (grpc.code === status.NOT_FOUND) {
    return new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  if (grpc.code === status.UNAVAILABLE || grpc.code === status.DEADLINE_EXCEEDED) {
    return new GraphQLError('Service unavailable. Try again.', {
      extensions: { code: 'UNAVAILABLE' },
    });
  }
  return new GraphQLError('Something went wrong.', {
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  });
}
