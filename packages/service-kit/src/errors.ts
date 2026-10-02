import { status } from '@grpc/grpc-js';
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { throwError } from 'rxjs';
import type { Logger } from '@chronos/logger';

export type DomainErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'already_exists'
  | 'permission_denied'
  | 'unauthenticated'
  | 'failed_precondition'
  | 'aborted'
  | 'resource_exhausted'
  | 'unavailable';

const GRPC_STATUS: Record<DomainErrorCode, number> = {
  invalid_argument: status.INVALID_ARGUMENT,
  not_found: status.NOT_FOUND,
  already_exists: status.ALREADY_EXISTS,
  permission_denied: status.PERMISSION_DENIED,
  unauthenticated: status.UNAUTHENTICATED,
  failed_precondition: status.FAILED_PRECONDITION,
  aborted: status.ABORTED,
  resource_exhausted: status.RESOURCE_EXHAUSTED,
  unavailable: status.UNAVAILABLE,
};

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  invalid_argument: 400,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  unauthenticated: 401,
  failed_precondition: 412,
  aborted: 409,
  resource_exhausted: 429,
  unavailable: 503,
};

/**
 * A failure the caller is allowed to know about. `message` is sent to the caller, so it must be a
 * fixed, generic sentence: never personal data, health data, ids or internals (CLAUDE.md rule 3).
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export const INTERNAL_MESSAGE = 'Internal error';

interface PublicError {
  grpcCode: number;
  httpCode: number;
  message: string;
}

/** Maps any thrown value to what the caller may see. Unknown errors become a generic internal error. */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof DomainError) {
    return {
      grpcCode: GRPC_STATUS[error.code],
      httpCode: HTTP_STATUS[error.code],
      message: error.message,
    };
  }
  return { grpcCode: status.INTERNAL, httpCode: 500, message: INTERNAL_MESSAGE };
}

/**
 * Global exception filter for gRPC and HTTP. Domain errors pass through with their code; everything
 * else is logged through the redacting logger and replaced with a generic message.
 */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  catch(error: unknown, host: ArgumentsHost) {
    const publicError = toPublicError(error);
    if (!(error instanceof DomainError)) {
      this.#logger.error(
        error instanceof Error ? error : { thrown: typeof error },
        'unhandled error',
      );
    }

    if (host.getType() === 'http') {
      const reply = host.switchToHttp().getResponse<{
        status: (code: number) => { send: (body: unknown) => void };
      }>();
      reply.status(publicError.httpCode).send({ error: publicError.message });
      return;
    }
    return throwError(() => ({ code: publicError.grpcCode, message: publicError.message }));
  }
}
