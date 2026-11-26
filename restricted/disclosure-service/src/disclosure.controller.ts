import {
  ConditionStatus as WireStatus,
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

// Validated at the edge. Field names are the proto-loader camelCase. Caps here only stop oversized
// input early; the service applies the real rules. Failures never echo what was sent.
const schemas = {
  account: z.object({ accountId: z.uuid() }),
  taxonomy: z.object({ includeRetired: z.boolean().default(false) }),
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

  @GrpcMethod(SERVICE, 'ListConditionTaxonomy')
  async listConditionTaxonomy(request: unknown): Promise<object> {
    const { includeRetired } = parse(schemas.taxonomy, request);
    return { entries: await this.#runtime.taxonomy.list({ includeRetired }) };
  }
}
