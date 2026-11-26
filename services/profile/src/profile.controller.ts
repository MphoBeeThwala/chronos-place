import {
  CandidatesOutcome as WireOutcome,
  PhotoModeration as WireModeration,
  Intent as WireIntent,
} from '@chronos/contracts/profile';
import { DomainError } from '@chronos/service-kit';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { z } from 'zod';
import type { Intent, PhotoModeration } from './db/schema.js';
import type { PhotoView } from './photos/photo.service.js';
import type { OwnProfileRecord } from './profiles/profile-store.js';
import type { CandidatesOutcome, PublicProfile } from './profiles/profile.service.js';
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
const OUTCOME: Record<CandidatesOutcome, WireOutcome> = {
  ok: WireOutcome.CANDIDATES_OUTCOME_OK,
  no_profile: WireOutcome.CANDIDATES_OUTCOME_NO_PROFILE,
  no_location: WireOutcome.CANDIDATES_OUTCOME_NO_LOCATION,
};

/** Candidate page tokens: the last row's distance and id, opaque to discovery. */
const candidateCursor = z.object({ d: z.number().nonnegative(), id: z.uuid() });
const encodeCursor = (c: { distanceMeters: number; accountId: string }) =>
  Buffer.from(JSON.stringify({ d: c.distanceMeters, id: c.accountId })).toString('base64url');
function decodeCursor(token: string): { distanceMeters: number; accountId: string } | undefined {
  if (token === '') return undefined;
  try {
    const c = candidateCursor.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    return { distanceMeters: c.d, accountId: c.id };
  } catch {
    throw new DomainError('invalid_argument', INVALID_REQUEST);
  }
}

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
  location: z.object({
    accountId: uuid,
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    clear: z.boolean().optional(),
  }),
  publicProfiles: z.object({
    viewerAccountId: uuid,
    accountIds: z.array(uuid).max(100).default([]),
  }),
  candidates: z.object({
    viewerAccountId: uuid,
    pageSize: z.number().int().min(0).max(500).default(0),
    pageToken: z.string().max(200).default(''),
  }),
  photoUpload: z.object({
    accountId: uuid,
    contentType: z.string().max(100),
    byteLength: z.number().int().nonnegative(),
  }),
  photoComplete: z.object({ accountId: uuid, uploadId: uuid }),
  photoReorder: z.object({ accountId: uuid, photoIds: z.array(uuid).max(6).default([]) }),
  photoDelete: z.object({ accountId: uuid, photoId: uuid }),
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

const MODERATION: Record<PhotoModeration, WireModeration> = {
  pending: WireModeration.PHOTO_MODERATION_PENDING,
  approved: WireModeration.PHOTO_MODERATION_APPROVED,
  rejected: WireModeration.PHOTO_MODERATION_REJECTED,
};

const photo = (p: PhotoView) => ({
  id: p.id,
  position: p.position,
  moderation: MODERATION[p.moderation],
  variants: p.variants,
  width: p.width,
  height: p.height,
});
const photoList = (photos: PhotoView[]) => ({ photos: photos.map(photo) });

/** Another member's view: a rounded distance and age, never a coordinate (M1.5 AC). */
const publicProfile = (p: PublicProfile, photos: PhotoView[] = []) => ({
  accountId: p.accountId,
  displayName: p.displayName,
  age: p.age,
  bio: p.bio ?? '',
  intent: INTENT[p.intent],
  gender: p.gender ?? '',
  pronouns: p.pronouns ?? '',
  areaLabel: p.areaLabel ?? '',
  ...(p.distanceKm === undefined ? {} : { distanceKm: p.distanceKm }),
  prompts: p.prompts,
  interests: p.interests,
  verified: p.verified,
  photos: photos.map(photo),
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

  @GrpcMethod(SERVICE, 'SetLocation')
  async setLocation(request: unknown) {
    const { accountId, latitude, longitude, clear } = parse(schemas.location, request);
    // proto3 does not send a number that equals 0, so a missing coordinate is 0 (equator, Greenwich).
    const point = clear === true ? null : { latitude: latitude ?? 0, longitude: longitude ?? 0 };
    return own(await this.#runtime.profiles.setLocation(accountId, point));
  }

  @GrpcMethod(SERVICE, 'GetPublicProfiles')
  async getPublicProfiles(request: unknown) {
    const { viewerAccountId, accountIds } = parse(schemas.publicProfiles, request);
    const profiles = await this.#runtime.profiles.publicProfiles(viewerAccountId, accountIds);
    // Approved photos only (ADR-0024 decision e); pending and rejected ones are the owner's alone.
    const photos = await this.#runtime.photos.approvedFor(profiles.map((p) => p.accountId));
    return { profiles: profiles.map((p) => publicProfile(p, photos.get(p.accountId))) };
  }

  @GrpcMethod(SERVICE, 'FindCandidates')
  async findCandidates(request: unknown) {
    const { viewerAccountId, pageSize, pageToken } = parse(schemas.candidates, request);
    const page = await this.#runtime.profiles.candidates(
      viewerAccountId,
      pageSize === 0 ? 500 : pageSize,
      decodeCursor(pageToken),
    );
    return {
      outcome: OUTCOME[page.outcome],
      candidates: page.candidates,
      nextPageToken: page.next ? encodeCursor(page.next) : '',
    };
  }

  @GrpcMethod(SERVICE, 'CreatePhotoUpload')
  async createPhotoUpload(request: unknown) {
    const { accountId, contentType, byteLength } = parse(schemas.photoUpload, request);
    const upload = await this.#runtime.photos.createUpload(accountId, contentType, byteLength);
    return { uploadId: upload.uploadId, uploadUrl: upload.uploadUrl, expiresAt: upload.expiresAt };
  }

  @GrpcMethod(SERVICE, 'CompletePhotoUpload')
  async completePhotoUpload(request: unknown) {
    const { accountId, uploadId } = parse(schemas.photoComplete, request);
    return { photo: photo(await this.#runtime.photos.completeUpload(accountId, uploadId)) };
  }

  @GrpcMethod(SERVICE, 'ListOwnPhotos')
  async listOwnPhotos(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    return photoList(await this.#runtime.photos.listOwn(accountId));
  }

  @GrpcMethod(SERVICE, 'ReorderPhotos')
  async reorderPhotos(request: unknown) {
    const { accountId, photoIds } = parse(schemas.photoReorder, request);
    return photoList(await this.#runtime.photos.reorder(accountId, photoIds));
  }

  @GrpcMethod(SERVICE, 'DeletePhoto')
  async deletePhoto(request: unknown) {
    const { accountId, photoId } = parse(schemas.photoDelete, request);
    return photoList(await this.#runtime.photos.remove(accountId, photoId));
  }

  @GrpcMethod(SERVICE, 'ExportProfile')
  async exportProfile(request: unknown) {
    const { accountId } = parse(schemas.account, request);
    const data = await this.#runtime.exporter.export(accountId);
    return {
      ...(data.own ? own(data.own) : {}),
      ...(data.location ? { location: data.location } : {}),
      photos: data.photos.map(photo),
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
    };
  }
}
