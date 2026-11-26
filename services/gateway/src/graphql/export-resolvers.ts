import { AccountStatus, ConsentType, VerificationFailure } from '@chronos/contracts/identity';
import { Intent, PhotoModeration } from '@chronos/contracts/profile';
import { GraphQLError } from 'graphql';
import type { GatewayContext } from '../auth/context.js';
import { fromGrpc } from '../identity/errors.js';
import { type IdentityClient, toDate, type WireTimestamp } from '../identity/identity-client.js';
import type { RateLimiter } from '../limits/rate-limit.js';
import type { ProfileClient } from '../profile/profile-client.js';
import type { ResolverMap } from './not-available.js';

/** The export's format. Bump it when a field changes meaning or is removed. */
export const EXPORT_FORMAT = 'chronos-export/1';

type Stamp = Date | WireTimestamp | null | undefined;

/** What identity's ExportAccount returns on the wire. */
interface WireAccountExport {
  account: { accountId: string; status: number };
  phoneE164: string;
  dateOfBirth?: { year: number; month: number; day: number } | null;
  createdAt: Stamp;
  consents?: { type: number; policyVersion: string; granted: boolean; recordedAt: Stamp }[];
  sessions?: { createdAt: Stamp; lastUsedAt: Stamp; expiresAt: Stamp; revokedAt?: Stamp }[];
  verifications?: {
    provider: string;
    outcome: string;
    failure: VerificationFailure;
    createdAt: Stamp;
    decidedAt?: Stamp;
  }[];
}

/** What profile's ExportProfile returns on the wire. */
interface WireProfileExport {
  profile?: {
    displayName: string;
    bio: string;
    intent: number;
    gender: string;
    pronouns: string;
    areaLabel: string;
    privateMode: boolean;
    visible: boolean;
    prompts?: { promptId: string; answer: string }[];
    interests?: string[];
  } | null;
  preferences?: {
    ageMin: number;
    ageMax: number;
    maxDistanceKm: number;
    intents?: number[];
    genders?: string[];
  } | null;
  location?: { latitude: number; longitude: number; updatedAt: Stamp } | null;
  photos?: {
    position: number;
    moderation: number;
    width: number;
    height: number;
    variants?: { size: number; url: string }[];
  }[];
  createdAt?: Stamp;
  updatedAt?: Stamp;
}

/** `CONSENT_TYPE_TERMS` → `terms`, from a generated enum and its wire number. */
function enumName(e: Record<string, string | number>, value: number, prefix: string): string {
  const name = e[value];
  return typeof name === 'string' ? name.replace(prefix, '').toLowerCase() : 'unspecified';
}

const iso = (t: Stamp) => (t ? toDate(t).toISOString() : null);
const blank = (s: string | undefined) => (s === undefined || s === '' ? null : s);
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Builds the member's export (ADR-0025 c, h, i): everything identity and profile hold, as one
 * JSON document. No health data: the Health Vault's part is built in the restricted zone (M2).
 */
export function buildExport(
  account: WireAccountExport,
  profile: WireProfileExport,
  generatedAt: Date,
): Record<string, unknown> {
  const dob = account.dateOfBirth;
  return {
    format: EXPORT_FORMAT,
    generatedAt: generatedAt.toISOString(),
    about:
      'Everything Chronos Place holds about you, apart from health information. ' +
      'Photo links work for 24 hours from generatedAt.',
    account: {
      id: account.account.accountId,
      status: enumName(AccountStatus, account.account.status, 'ACCOUNT_STATUS_'),
      phoneNumber: account.phoneE164,
      dateOfBirth: dob ? `${String(dob.year)}-${pad(dob.month)}-${pad(dob.day)}` : null,
      createdAt: iso(account.createdAt),
    },
    consents: (account.consents ?? []).map((c) => ({
      type: enumName(ConsentType, c.type, 'CONSENT_TYPE_'),
      policyVersion: c.policyVersion,
      granted: c.granted,
      recordedAt: iso(c.recordedAt),
    })),
    sessions: (account.sessions ?? []).map((s) => ({
      startedAt: iso(s.createdAt),
      lastUsedAt: iso(s.lastUsedAt),
      expiresAt: iso(s.expiresAt),
      endedAt: iso(s.revokedAt),
    })),
    verifications: (account.verifications ?? []).map((v) => ({
      provider: v.provider,
      outcome: v.outcome,
      failure:
        v.failure === VerificationFailure.VERIFICATION_FAILURE_UNSPECIFIED
          ? null
          : enumName(VerificationFailure, v.failure, 'VERIFICATION_FAILURE_'),
      startedAt: iso(v.createdAt),
      decidedAt: iso(v.decidedAt),
    })),
    profile: profile.profile
      ? {
          displayName: profile.profile.displayName,
          bio: blank(profile.profile.bio),
          intent: enumName(Intent, profile.profile.intent, 'INTENT_'),
          gender: blank(profile.profile.gender),
          pronouns: blank(profile.profile.pronouns),
          areaLabel: blank(profile.profile.areaLabel),
          privateMode: profile.profile.privateMode,
          visible: profile.profile.visible,
          prompts: profile.profile.prompts ?? [],
          interests: profile.profile.interests ?? [],
          createdAt: iso(profile.createdAt),
          updatedAt: iso(profile.updatedAt),
        }
      : null,
    preferences: profile.preferences
      ? {
          ageMin: profile.preferences.ageMin,
          ageMax: profile.preferences.ageMax,
          maxDistanceKm: profile.preferences.maxDistanceKm,
          intents: (profile.preferences.intents ?? []).map((i) => enumName(Intent, i, 'INTENT_')),
          genders: profile.preferences.genders ?? [],
        }
      : null,
    location: profile.location
      ? {
          latitude: profile.location.latitude,
          longitude: profile.location.longitude,
          updatedAt: iso(profile.location.updatedAt),
          about: 'Rounded to about 1 km. Used only for distances; only you ever see it.',
        }
      : null,
    photos: (profile.photos ?? []).map((p) => ({
      position: p.position,
      status: enumName(PhotoModeration, p.moderation, 'PHOTO_MODERATION_'),
      width: p.width,
      height: p.height,
      links: (p.variants ?? []).map((v) => ({ size: v.size, url: v.url })),
    })),
  };
}

export interface ExportResolverDeps {
  identity: IdentityClient;
  profile: ProfileClient;
  rateLimiter: Pick<RateLimiter, 'checkDataExport'>;
  now?: () => Date;
}

const SIGN_IN = (): GraphQLError =>
  new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });

/** "Download my data" (TASKS M1.8, ADR-0025). */
export function exportResolvers(deps: ExportResolverDeps): ResolverMap {
  const now = deps.now ?? (() => new Date());
  return {
    Query: {
      myDataExport: async (_parent, _args, ctx) => {
        const context = ctx as GatewayContext;
        if (!context.viewer) throw SIGN_IN();
        const { accountId } = context.viewer;
        await deps.rateLimiter.checkDataExport(accountId);
        // The response carries the member's number and date of birth: never cache it anywhere.
        context.noStore = true;
        try {
          const [account, profile] = await Promise.all([
            deps.identity.call<WireAccountExport>('exportAccount', { accountId }),
            deps.profile.call<WireProfileExport>('exportProfile', { accountId }),
          ]);
          const generatedAt = now();
          return {
            format: EXPORT_FORMAT,
            generatedAt: generatedAt.toISOString(),
            json: JSON.stringify(buildExport(account, profile, generatedAt), null, 2),
          };
        } catch (error) {
          throw fromGrpc(error);
        }
      },
    },
  };
}
