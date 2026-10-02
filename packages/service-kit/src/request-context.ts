import { currentRequestId, runWithRequestId } from '@chronos/logger';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

const HEADER = 'x-request-id';

interface GrpcMetadataLike {
  get: (key: string) => unknown[];
}

function incomingId(context: ExecutionContext): string | undefined {
  if (context.getType() === 'http') {
    const header = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers[HEADER];
    return Array.isArray(header) ? header[0] : header;
  }
  const metadata = context.switchToRpc().getContext<GrpcMetadataLike | undefined>();
  const value = metadata?.get(HEADER)[0];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Gives every request an id (taken from `x-request-id` if it is safe, otherwise generated) that all
 * log lines written while handling it carry. HTTP responses echo the id.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const candidate = incomingId(context);
    return new Observable((subscriber) =>
      runWithRequestId(candidate, () => {
        if (context.getType() === 'http') {
          const reply = context
            .switchToHttp()
            .getResponse<{ header: (name: string, value: string) => void }>();
          const id = currentRequestId();
          if (id !== undefined) reply.header(HEADER, id);
        }
        return next.handle().subscribe(subscriber);
      }),
    );
  }
}
