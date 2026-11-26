import {
  ConditionStatus as WireStatus,
  GrantScope as WireScope,
  Purpose as WirePurpose,
  Visibility as WireVisibility,
} from '@chronos/contracts/disclosure';
import { DomainError } from '@chronos/service-kit';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { z } from 'zod';
import {
  MAX_CONDITIONS,
  MAX_TEXT_LENGTH,
  type ConditionStatus,
  type OwnHealthProfile,
} from './health/health-profile.js';
import { INVALID_PROFILE } from './health/health-profile.service.js';
import type { Scope, ViewPurpose } from './access/decide.js';
import type { DisclosureRuntime } from './runtime.js';

export const DISCLOSURE_RUNTIME = Symbol('DISCLOSURE_RUNTIME');

const SERVICE = 'DisclosureService';
const INVALID_REQUEST = 'Invalid request.';

const STATUS: Record<ConditionStatus, WireStatus> = {
  living_with: WireStatus.CONDITION_STATUS_LIVING_WITH,
  in_remission: WireStatus.CONDITION_STATUS_IN_REMISSION,
  survivor: WireStatus.CONDITION_STATUS_SURVIVOR,
};
const STATUS_FROM_WIRE = new Map<number, ConditionStatus>(
  (Object.entries(STATUS) as [ConditionStatus, WireStatus][]).map(([k, v]) => [v, k]),
);
const VISIBILITY: Record<OwnHealthProfile['visibility'], WireVisibility> = {
  hidden: WireVisibility.VISIBILITY_HIDDEN,
  match_only: WireVisibility.VISIBILITY_MATCH_ONLY,
  chat_grant: WireVisibility.VISIBILITY_CHAT_GRANT,
  profile: WireVisibility.VISIBILITY_PROFILE,
};
const VISIBILITY_FROM_WIRE = new Map<number, OwnHealthProfile['visibility']>(
  (Object.entries(VISIBILITY) as [OwnHealthProfile['visibility'], WireVisibility][]).map(
    ([k, v]) => [v, k],
  ),
);
const PURPOSE_FROM_WIRE = new Map<number, ViewPurpose>([
  [WirePurpose.PURPOSE_PROFILE_VIEW, 'profile_view'],
  [WirePurpose.PURPOSE_CHAT_CARD, 'chat_card'],
  [WirePurpose.PURPOSE_MODERATION, 'moderation'],
]);
const SCOPE: Record<Scope, WireScope> = {
  full: WireScope.GRANT_SCOPE_FULL,
  conditions_only: WireScope.GRANT_SCOPE_CONDITIONS_ONLY,
};
const SCOPE_FROM_WIRE = new Map<number, Scope>(
  (Object.entries(SCOPE) as [Scope, WireScope][]).map(([k, v]) => [v, k]),
);

// Validated at the edge. Field names are the proto-loader camelCase. Caps here only stop oversized
// input early; the service applies the real rules. Failures never echo what was sent.
const schemas = {
  account: z.object({ accountId: z.uuid() }),
  taxonomy: z.object({ includeRetired: z.boolean().default(false) }),
  visibility: z.object({
    accountId: z.uuid(),
    visibility: z.number().int().default(0),
    filterOptIn: z.boolean().default(false),
  }),
  pair: z.object({ subjectAccountId: z.uuid(), viewerAccountId: z.uuid() }),
  grant: z.object({
    subjectAccountId: z.uuid(),
    viewerAccountId: z.uuid(),
    scope: z.number().int().default(0),
  }),
  viewers: z.object({
    subjectAccountId: z.uuid(),
    pageSize: z.number().int().min(0).default(0),
    pageToken: z.string().max(200).default(''),
  }),
  view: z.object({
    viewerAccountId: z.uuid(),
    subjectAccountId: z.uuid(),
    purpose: z.number().int().default(0),
    moderation: z.object({ staffId: z.uuid() }).optional(),
  }),
  upsert: z.object({
    accountId: z.uuid(),
    expectedVersion: z.number().int().min(0).default(0),
    profile: z
      .object({
        conditions: z
          .array(
            z.object({ code: z.string().max(40).default(''), status: z.number().int().default(0) }),
          )
          .max(MAX_CONDITIONS)
          .default([]),
        freeText: z
          .string()
          .max(MAX_TEXT_LENGTH * 2)
          .optional(),
        note: z
          .string()
          .max(MAX_TEXT_LENGTH * 2)
          .optional(),
      })
      .default({ conditions: [] }),
  }),
};

function parse<T extends z.ZodType>(schema: T, request: unknown): z.output<T> {
  const result = schema.safeParse(request);
  if (!result.success) throw new DomainError('invalid_argument', INVALID_REQUEST);
  return result.data;
}

function known<T>(map: Map<number, T>, value: number): T {
  const found = map.get(value);
  if (found === undefined) throw new DomainError('invalid_argument', INVALID_REQUEST);
  return found;
}

function statusFromWire(value: number): ConditionStatus {
  const known = STATUS_FROM_WIRE.get(value);
  if (known === undefined) throw new DomainError('invalid_argument', INVALID_PROFILE);
  return known;
}

/**
 * gRPC API of the Disclosure Service (packages/contracts/proto/chronos/disclosure/v1). Methods
 * not implemented here answer UNIMPLEMENTED until their tasks (M2.3–M2.7).
 */
@Controller()
export class DisclosureController {
  readonly #runtime: DisclosureRuntime;

  constructor(@Inject(DISCLOSURE_RUNTIME) runtime: DisclosureRuntime) {
    this.#runtime = runtime;
  }

  @GrpcMethod(SERVICE, 'UpsertHealthProfile')
  async upsertHealthProfile(request: unknown): Promise<{ version: number }> {
    const { accountId, expectedVersion, profile } = parse(schemas.upsert, request);
    const domain = {
      conditions: profile.conditions.map((c) => ({
        code: c.code,
        status: statusFromWire(c.status),
      })),
      ...(profile.freeText ? { freeText: profile.freeText } : {}),
      ...(profile.note ? { note: profile.note } : {}),
    };
    const version = await this.#runtime.profiles.upsert(accountId, domain, expectedVersion);
    return { version };
  }

  @GrpcMethod(SERVICE, 'GetOwnHealthProfile')
  async getOwnHealthProfile(request: unknown): Promise<object> {
    const { accountId } = parse(schemas.account, request);
    const own = await this.#runtime.profiles.getOwn(accountId);
    if (own === undefined) return {};
    return {
      profile: {
        profile: {
          conditions: own.profile.conditions.map((c) => ({
            code: c.code,
            status: STATUS[c.status],
          })),
          freeText: own.profile.freeText ?? '',
          note: own.profile.note ?? '',
        },
        visibility: VISIBILITY[own.visibility],
        filterOptIn: own.filterOptIn,
        version: own.version,
      },
    };
  }

  @GrpcMethod(SERVICE, 'SetVisibility')
  async setVisibility(request: unknown): Promise<object> {
    const { accountId, visibility, filterOptIn } = parse(schemas.visibility, request);
    const saved = await this.#runtime.profiles.setVisibility(
      accountId,
      known(VISIBILITY_FROM_WIRE, visibility),
      filterOptIn,
    );
    return { visibility: VISIBILITY[saved.visibility], filterOptIn: saved.filterOptIn };
  }

  @GrpcMethod(SERVICE, 'ViewHealthProfile')
  async viewHealthProfile(request: unknown): Promise<object> {
    const { viewerAccountId, subjectAccountId, purpose, moderation } = parse(schemas.view, request);
    const view = await this.#runtime.views.view({
      viewerId: viewerAccountId,
      subjectId: subjectAccountId,
      purpose: known(PURPOSE_FROM_WIRE, purpose),
      staffId: moderation?.staffId,
    });
    if (view === undefined) return { allowed: false };
    return {
      allowed: true,
      profile: {
        conditions: view.conditions.map((c) => ({ code: c.code, status: STATUS[c.status] })),
        freeText: view.freeText ?? '',
        note: view.note ?? '',
        scope: SCOPE[view.scope],
        leaseExpiresAt: view.leaseExpiresAt,
      },
    };
  }

  @GrpcMethod(SERVICE, 'GrantDisclosure')
  async grantDisclosure(request: unknown): Promise<object> {
    const { subjectAccountId, viewerAccountId, scope } = parse(schemas.grant, request);
    const grant = await this.#runtime.sharing.grant(
      subjectAccountId,
      viewerAccountId,
      known(SCOPE_FROM_WIRE, scope),
    );
    return { grantId: grant.id, grantedAt: grant.grantedAt };
  }

  @GrpcMethod(SERVICE, 'RevokeDisclosure')
  async revokeDisclosure(request: unknown): Promise<object> {
    const { subjectAccountId, viewerAccountId } = parse(schemas.pair, request);
    return { revoked: await this.#runtime.sharing.revoke(subjectAccountId, viewerAccountId) };
  }

  @GrpcMethod(SERVICE, 'ListHealthViewers')
  async listHealthViewers(request: unknown): Promise<object> {
    const { subjectAccountId, pageSize, pageToken } = parse(schemas.viewers, request);
    return this.#runtime.viewers.list(subjectAccountId, pageSize, pageToken);
  }

  @GrpcMethod(SERVICE, 'ListConditionTaxonomy')
  async listConditionTaxonomy(request: unknown): Promise<object> {
    const { includeRetired } = parse(schemas.taxonomy, request);
    return { entries: await this.#runtime.taxonomy.list({ includeRetired }) };
  }
}
