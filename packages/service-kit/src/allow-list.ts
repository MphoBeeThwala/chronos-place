import type { Logger } from '@chronos/logger';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { callerOf } from './caller-identity.js';
import { DomainError } from './errors.js';

/** A caller allowed on a method, optionally only for some requests (checked on the decoded request). */
export type AllowedCaller = string | { caller: string; when: (request: unknown) => boolean };

/**
 * Per-method caller allow-list for one gRPC service (M2.5). Default deny: a method that is not
 * listed, a caller that is not listed, and a call without a verified client certificate are all
 * refused with PERMISSION_DENIED. The gRPC health service is exempt (it carries no data).
 */
export interface AllowList {
  /** Fully qualified service, e.g. `chronos.disclosure.v1.DisclosureService`. */
  service: string;
  methods: Readonly<Record<string, readonly AllowedCaller[]>>;
}

export const PERMISSION_DENIED_MESSAGE = 'Permission denied.';
const HEALTH_PREFIX = '/grpc.health.v1.Health/';

interface ServerCall {
  getPath?: () => string;
}

/** Decides one call. Exported for unit tests; the guard below is what services use. */
export function isAllowed(
  list: AllowList,
  path: string,
  caller: string | undefined,
  request: unknown,
): boolean {
  if (path.startsWith(HEALTH_PREFIX)) return true;
  if (caller === undefined) return false;
  const prefix = `/${list.service}/`;
  if (!path.startsWith(prefix)) return false;
  const rules = Object.hasOwn(list.methods, path.slice(prefix.length))
    ? list.methods[path.slice(prefix.length)]
    : undefined;
  return (rules ?? []).some((rule) =>
    typeof rule === 'string' ? rule === caller : rule.caller === caller && rule.when(request),
  );
}

@Injectable()
export class CallerAllowListGuard implements CanActivate {
  constructor(
    private readonly list: AllowList,
    private readonly logger: Logger,
    private readonly trustDomain: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return true;
    const request: unknown = context.getArgByIndex(0);
    const call = context.getArgByIndex<ServerCall | undefined>(2);
    const path = call?.getPath?.() ?? '';
    const caller = callerOf(call, this.trustDomain);
    if (isAllowed(this.list, path, caller, request)) return true;
    // Method path and caller name only: never the request.
    this.logger.warn({ grpcPath: path, caller: caller ?? 'unidentified' }, 'grpc caller denied');
    throw new DomainError('permission_denied', PERMISSION_DENIED_MESSAGE);
  }
}
