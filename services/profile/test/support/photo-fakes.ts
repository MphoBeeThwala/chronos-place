import { createLogger } from '@chronos/logger';
import sharp from 'sharp';
import type { PhotoModeration } from '../../src/db/schema.js';
import type { PhotoModerator } from '../../src/photos/moderator.js';
import { InMemoryPhotoStorage } from '../../src/photos/photo-storage.js';
import {
  type AddResult,
  MAX_PHOTOS,
  type PhotoRecord,
  type PhotoStore,
  type UploadRecord,
} from '../../src/photos/photo-store.js';
import { PhotoService } from '../../src/photos/photo.service.js';

/** The photo store's contract, in memory, for unit tests. */
export class InMemoryPhotoStore implements PhotoStore {
  readonly profiles = new Set<string>();
  readonly uploads = new Map<string, UploadRecord>();
  readonly photos = new Map<string, PhotoRecord>();

  #of(accountId: string) {
    return [...this.photos.values()]
      .filter((p) => p.accountId === accountId)
      .sort((a, b) => a.position - b.position);
  }

  hasProfile(accountId: string) {
    return Promise.resolve(this.profiles.has(accountId));
  }
  count(accountId: string) {
    return Promise.resolve(this.#of(accountId).length);
  }
  openUploads(accountId: string, now: Date) {
    return Promise.resolve(
      [...this.uploads.values()].filter((u) => u.accountId === accountId && u.expiresAt > now)
        .length,
    );
  }
  insertUpload(upload: UploadRecord) {
    this.uploads.set(upload.id, { ...upload });
    return Promise.resolve();
  }
  findUpload(accountId: string, uploadId: string) {
    const upload = this.uploads.get(uploadId);
    return Promise.resolve(upload?.accountId === accountId ? { ...upload } : undefined);
  }
  deleteUpload(uploadId: string) {
    this.uploads.delete(uploadId);
    return Promise.resolve();
  }
  expiredUploads(before: Date, limit: number) {
    return Promise.resolve(
      [...this.uploads.values()]
        .filter((u) => u.expiresAt <= before)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, limit),
    );
  }
  add(photo: Omit<PhotoRecord, 'position'>): Promise<AddResult> {
    if (!this.profiles.has(photo.accountId)) return Promise.resolve({ noProfile: true });
    const position = this.#of(photo.accountId).length;
    if (position >= MAX_PHOTOS) return Promise.resolve({ full: true });
    const added = { ...photo, position };
    this.photos.set(photo.id, added);
    return Promise.resolve({ added: { ...added } });
  }
  setModeration(photoId: string, moderation: PhotoModeration) {
    const photo = this.photos.get(photoId);
    if (photo) photo.moderation = moderation;
    return Promise.resolve();
  }
  list(accountId: string) {
    return Promise.resolve(this.#of(accountId).map((p) => ({ ...p })));
  }
  approved(accountIds: readonly string[]) {
    return Promise.resolve(
      accountIds.flatMap((id) =>
        this.#of(id)
          .filter((p) => p.moderation === 'approved')
          .map((p) => ({ ...p })),
      ),
    );
  }
  reorder(accountId: string, photoIds: readonly string[]) {
    const mine = this.#of(accountId);
    const same =
      photoIds.length === mine.length &&
      new Set(photoIds).size === photoIds.length &&
      photoIds.every((id) => this.photos.get(id)?.accountId === accountId);
    if (!same) return Promise.resolve(false);
    photoIds.forEach((id, position) => {
      const photo = this.photos.get(id);
      if (photo) photo.position = position;
    });
    return Promise.resolve(true);
  }
  remove(accountId: string, photoId: string) {
    if (this.photos.get(photoId)?.accountId !== accountId) return Promise.resolve(false);
    this.photos.delete(photoId);
    this.#of(accountId).forEach((p, position) => {
      p.position = position;
    });
    return Promise.resolve(true);
  }
}

export class FixedModerator implements PhotoModerator {
  readonly reviewed: { id: string; accountId: string }[] = [];
  constructor(public status: PhotoModeration = 'approved') {}
  review(photo: { id: string; accountId: string }) {
    this.reviewed.push(photo);
    return Promise.resolve(this.status);
  }
}

/** A plain synthetic JPEG (no metadata of interest). */
export const syntheticJpeg = (width = 800, height = 600) =>
  sharp({ create: { width, height, channels: 3, background: '#6699cc' } })
    .jpeg()
    .toBuffer();

export function photoSetup(
  options: { destination?: { write: (l: string) => void }; now?: () => Date } = {},
) {
  const photos = new InMemoryPhotoStore();
  const storage = new InMemoryPhotoStorage();
  const moderator = new FixedModerator();
  const service = new PhotoService({
    photos,
    storage,
    moderator,
    logger: createLogger({
      service: 'profile-test',
      level: 'trace',
      destination: options.destination ?? { write: () => undefined },
    }),
    ...(options.now ? { now: options.now } : {}),
  });
  return { photos, storage, moderator, service };
}
