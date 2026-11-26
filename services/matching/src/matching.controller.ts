import { DomainError } from '@chronos/service-kit';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { z } from 'zod';
import type { MatchingRuntime } from './runtime.js';

export const MATCHING_RUNTIME = Symbol('MATCHING_RUNTIME');

const SERVICE = 'MatchingService';
// Fixed messages: never say whether someone blocked you.
const INVALID = 'Invalid request.';
const MATCH_NOT_FOUND = 'That match was not found.';
export const MAX_CANDIDATES = 500;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const notSelf = (x: string, y: string) => x !== y;
const schemas = {
  like: z
    .object({ fromAccountId: z.uuid(), toAccountId: z.uuid() })
    .refine((v) => notSelf(v.fromAccountId, v.toAccountId)),
  block: z
    .object({ blockerAccountId: z.uuid(), blockedAccountId: z.uuid() })
    .refine((v) => notSelf(v.blockerAccountId, v.blockedAccountId)),
  relationship: z
    .object({ accountId: z.uuid(), otherAccountId: z.uuid() })
    .refine((v) => notSelf(v.accountId, v.otherAccountId)),
  unmatch: z.object({ accountId: z.uuid(), matchId: z.uuid() }),
  account: z.object({ accountId: z.uuid() }),
  page: z.object({
    accountId: z.uuid(),
    pageSize: z.number().int().min(0).default(0),
    pageToken: z.string().max(200).default(''),
  }),
  visible: z.object({
    viewerAccountId: z.uuid(),
    candidateAccountIds: z.array(z.uuid()).max(MAX_CANDIDATES).default([]),
  }),
};

function parse<T extends z.ZodType>(schema: T, request: unknown): z.output<T> {
  const result = schema.safeParse(request);
  if (!result.success) throw new DomainError('invalid_argument', INVALID);
  return result.data;
}

const cursor = z.object({ t: z.iso.datetime(), id: z.uuid() });
const encode = (c: z.infer<typeof cursor>) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(token: string) {
  try {
    const c = cursor.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    return { createdAt: new Date(c.t), id: c.id };
  } catch {
    throw new DomainError('invalid_argument', INVALID);
  }
}

/** gRPC API of the matching service (packages/contracts/proto/chronos/matching/v1). */
@Controller()
export class MatchingController {
  readonly #runtime: MatchingRuntime;

  constructor(@Inject(MATCHING_RUNTIME) runtime: MatchingRuntime) {
    this.#runtime = runtime;
  }

  @GrpcMethod(SERVICE, 'Like')
  async like(request: unknown): Promise<object> {
    const r = parse(schemas.like, request);
    return this.#runtime.store.like(r.fromAccountId, r.toAccountId);
  }

  @GrpcMethod(SERVICE, 'Pass')
  async pass(request: unknown): Promise<object> {
    const r = parse(schemas.like, request);
    await this.#runtime.store.pass(r.fromAccountId, r.toAccountId);
    return {};
  }

  @GrpcMethod(SERVICE, 'Unmatch')
  async unmatch(request: unknown): Promise<object> {
    const { accountId, matchId } = parse(schemas.unmatch, request);
    if (!(await this.#runtime.store.unmatch(accountId, matchId))) {
      throw new DomainError('not_found', MATCH_NOT_FOUND);
    }
    return {};
  }

  @GrpcMethod(SERVICE, 'Block')
  async block(request: unknown): Promise<object> {
    const r = parse(schemas.block, request);
    await this.#runtime.store.block(r.blockerAccountId, r.blockedAccountId);
    return {};
  }

  @GrpcMethod(SERVICE, 'Unblock')
  async unblock(request: unknown): Promise<object> {
    const r = parse(schemas.block, request);
    await this.#runtime.store.unblock(r.blockerAccountId, r.blockedAccountId);
    return {};
  }

  @GrpcMethod(SERVICE, 'ListMatches')
  async listMatches(request: unknown): Promise<object> {
    const { accountId, pageSize, pageToken } = parse(schemas.page, request);
    const size = pageSize === 0 ? DEFAULT_PAGE : Math.min(pageSize, MAX_PAGE);
    const rows = await this.#runtime.store.listMatches(
      accountId,
      size + 1,
      pageToken === '' ? undefined : decode(pageToken),
    );
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      matches: page,
      nextPageToken:
        rows.length > size && last
          ? encode({ t: last.createdAt.toISOString(), id: last.matchId })
          : '',
    };
  }

  @GrpcMethod(SERVICE, 'ListBlocked')
  async listBlocked(request: unknown): Promise<object> {
    const { accountId } = parse(schemas.account, request);
    return { blocked: await this.#runtime.store.listBlocked(accountId) };
  }

  @GrpcMethod(SERVICE, 'GetRelationship')
  async getRelationship(request: unknown): Promise<object> {
    const r = parse(schemas.relationship, request);
    return this.#runtime.store.relationship(r.accountId, r.otherAccountId);
  }

  @GrpcMethod(SERVICE, 'FilterVisible')
  async filterVisible(request: unknown): Promise<object> {
    const { viewerAccountId, candidateAccountIds } = parse(schemas.visible, request);
    return {
      visibleAccountIds: await this.#runtime.store.filterVisible(
        viewerAccountId,
        candidateAccountIds,
      ),
    };
  }
}
