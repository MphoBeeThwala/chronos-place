import { Intent as WireIntent } from '@chronos/contracts/profile';
import { DomainError } from '@chronos/service-kit';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { z } from 'zod';
import type { Intent } from './db/schema.js';
import type { OwnProfileRecord } from './profiles/profile-store.js';
import type { ProfileRuntime } from './runtime.js';

export const PROFILE_RUNTIME = Symbol('PROFILE_RUNTIME');

const SERVICE = 'ProfileService';
const INVALID_REQUEST = 'Invalid request.';

const INTENT: Record<Intent, WireIntent> = {
  long_term: WireIntent.INTENT_LONG_TERM,
  dating: WireIntent.INTENT_DATING,
  friendship: WireIntent.INTENT_FRIENDSHIP,
  open: WireIntent.INTENT_OPEN,
};
const INTENT_FROM_WIRE = new Map<number, Intent>(
  (Object.entries(INTENT) as [Intent, WireIntent][]).map(([k, v]) => [v, k]),
);

// Validated at the edge (CLAUDE.md coding standards). Field names are the proto-loader camelCase.
// Generous caps here only stop oversized input early; the service applies the real limits.
const text = z.string().max(2_000);
const uuid = z.uuid();
const intent = z.number().int().optional();
const schemas = {
  account: z.object({ accountId: uuid }),
  profile: z.object({
    accountId: uuid,
    displayName: text.optional(),
    bio: text.optional(),
    intent,
    gender: text.optional(),
    pronouns: text.optional(),
    areaLabel: text.optional(),
    privateMode: z.boolean().optional(),
    visible: z.boolean().optional(),
    prompts: z
      .object({
        items: z
          .array(z.object({ promptId: z.string().max(64), answer: text }))
          .max(10)
          .default([]),
      })
      .optional(),
    interests: z.object({ ids: z.array(z.string().max(64)).max(20).default([]) }).optional(),
  }),
  preferences: z.object({
    accountId: uuid,
    ageMin: z.number().int().optional(),
    ageMax: z.number().int().optional(),
    maxDistanceKm: z.number().int().optional(),
    intents: z.object({ values: z.array(z.number().int()).max(10).default([]) }).optional(),
    genders: z.object({ values: z.array(z.string().max(200)).max(20).default([]) }).optional(),
  }),
};

function parse<T extends z.ZodType>(schema: T, request: unknown): z.output<T> {
  const result = schema.safeParse(request);
  if (!result.success) throw new DomainError('invalid_argument', INVALID_REQUEST);
  return result.data;
}

function fromWire(value: number): Intent {
  const known = INTENT_FROM_WIRE.get(value);
  if (known === undefined) throw new DomainError('invalid_argument', INVALID_REQUEST);
  return known;
}

/** Unset (0) means "no change"; anything else must be a known intent. */
const optionalIntent = (value: number | undefined) =>
  value === undefined || value === 0 ? undefined : fromWire(value);

const own = ({ profile, preferences }: OwnProfileRecord) => ({
  profile: {
    accountId: profile.accountId,
    displayName: profile.displayName,
    bio: profile.bio ?? '',
    intent: INTENT[profile.intent],
    gender: profile.gender ?? '',
    pronouns: profile.pronouns ?? '',
    areaLabel: profile.areaLabel ?? '',
    privateMode: profile.privateMode,
    visible: profile.visible,
    prompts: profile.prompts,
    interests: profile.interests,
    hasLocation: profile.hasLocation,
  },
  preferences: {
    ageMin: preferences.ageMin,
    ageMax: preferences.ageMax,
    maxDistanceKm: preferences.maxDistanceKm,
    intents: preferences.intents.map((i) => INTENT[i]),
    genders: preferences.genders,
  },
});

/** chronos.profile.v1.ProfileService. Only the gateway calls it (allow-list arrives with M2.5). */
@Controller()
export class ProfileController {
  readonly #runtime: ProfileRuntime;

  constructor(@Inject(PROFILE_RUNTIME) runtime: ProfileRuntime) {
    this.#runtime = runtime;
  }

  @GrpcMethod(SERVICE, 'GetOwnProfile')
  async getOwnProfile(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    return own(await this.#runtime.profiles.getOwn(accountId));
  }

  @GrpcMethod(SERVICE, 'UpdateProfile')
  async updateProfile(request: unknown) {
    const {
      accountId,
      intent: wireIntent,
      prompts,
      interests,
      ...fields
    } = parse(schemas.profile, request);
    const intent = optionalIntent(wireIntent);
    const update = {
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      ...(intent ? { intent } : {}),
      ...(prompts ? { prompts: prompts.items } : {}),
      ...(interests ? { interests: interests.ids } : {}),
    };
    return own(await this.#runtime.profiles.update(accountId, update));
  }

  @GrpcMethod(SERVICE, 'UpdatePreferences')
  async updatePreferences(request: unknown) {
    const { accountId, intents, genders, ...numbers } = parse(schemas.preferences, request);
    const update = {
      ...Object.fromEntries(Object.entries(numbers).filter(([, v]) => v !== undefined)),
      ...(intents ? { intents: intents.values.map(fromWire) } : {}),
      ...(genders ? { genders: genders.values } : {}),
    };
    return own(await this.#runtime.profiles.updatePreferences(accountId, update));
  }

  @GrpcMethod(SERVICE, 'GetCatalogue')
  getCatalogue() {
    return this.#runtime.profiles.catalogue();
  }
}
