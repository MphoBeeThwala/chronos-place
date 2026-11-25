import { randomUUID } from 'node:crypto';
import type { Logger } from '@chronos/logger';
import { DomainError } from '@chronos/service-kit';
import type { PhotoModerator } from './moderator.js';
import type { PhotoStorage } from './photo-storage.js';
import { MAX_PHOTOS, type PhotoRecord, type PhotoStore } from './photo-store.js';
import {
  ACCEPTED_TYPES,
  MAX_UPLOAD_BYTES,
  PHOTO_SIZES,
  processPhoto,
  sniffType,
} from './process.js';

/** Upload links last 5 minutes; view links 1 hour (ADR-0024 decisions a and d). */
export const UPLOAD_TTL_SECONDS = 5 * 60;
export const VIEW_TTL_SECONDS = 60 * 60;
/** Quarantine objects of uploads never completed are deleted this long after the link expires. */
export const ABANDONED_GRACE_MS = 10 * 60 * 1000;

const MESSAGES = {
  needsProfile: 'Create your profile first.',
  full: `You can have up to ${String(MAX_PHOTOS)} photos. Delete one to add another.`,
  type: 'Choose a JPEG, PNG or WebP photo of up to 10 MB.',
  expired: 'That upload has expired. Please try again.',
  notUploaded: 'The photo did not finish uploading. Please try again.',
  unknown: 'That photo was not found.',
  order: 'That order does not match your photos.',
} as const;

const LOG_UPLOAD_ISSUED = 'photo upload issued';
const LOG_ADDED = 'photo added';
const LOG_REFUSED = 'photo upload refused';
const LOG_REORDERED = 'photos reordered';
const LOG_DELETED = 'photo deleted';
const LOG_ABANDONED_CLEARED = 'abandoned photo upload cleared';
const LOG_ABANDONED_FAILED = 'abandoned photo upload cleanup failed';

export const uploadKey = (uploadId: string) => `uploads/${uploadId}`;
export const mediaKey = (photoId: string, size: number) => `photos/${photoId}/${String(size)}.webp`;
const allSizes = (photoId: string) => PHOTO_SIZES.map((size) => mediaKey(photoId, size));

export interface PhotoView extends PhotoRecord {
  variants: { size: number; url: string }[];
}

export interface PhotoServiceDeps {
  photos: PhotoStore;
  storage: PhotoStorage;
  moderator: PhotoModerator;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
}

const invalid = (message: string): never => {
  throw new DomainError('invalid_argument', message);
};
const precondition = (message: string): never => {
  throw new DomainError('failed_precondition', message);
};

/**
 * Profile photos (TASKS M1.6, ADR-0024). The browser uploads into quarantine; nothing it sent is
 * kept. Each photo is re-encoded without metadata, stored in three sizes under random keys, and
 * shown to others only once approved. Logs carry ids only.
 */
export class PhotoService {
  readonly #d: Required<PhotoServiceDeps>;

  constructor(deps: PhotoServiceDeps) {
    this.#d = { now: () => new Date(), newId: randomUUID, ...deps };
  }

  async createUpload(accountId: string, contentType: string, byteLength: number) {
    if (
      !(ACCEPTED_TYPES as readonly string[]).includes(contentType) ||
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > MAX_UPLOAD_BYTES
    ) {
      invalid(MESSAGES.type);
    }
    if (!(await this.#d.photos.hasProfile(accountId))) {
      throw new DomainError('not_found', MESSAGES.needsProfile);
    }
    const now = this.#d.now();
    const [count, open] = await Promise.all([
      this.#d.photos.count(accountId),
      this.#d.photos.openUploads(accountId, now),
    ]);
    if (count + open >= MAX_PHOTOS) precondition(MESSAGES.full);

    const uploadId = this.#d.newId();
    const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000);
    await this.#d.photos.insertUpload({
      id: uploadId,
      accountId,
      contentType,
      byteLength,
      expiresAt,
    });
    const uploadUrl = await this.#d.storage.uploadUrl(
      uploadKey(uploadId),
      contentType,
      byteLength,
      UPLOAD_TTL_SECONDS,
    );
    this.#d.logger.info({ accountId, uploadId }, LOG_UPLOAD_ISSUED);
    return { uploadId, uploadUrl, expiresAt };
  }

  async completeUpload(accountId: string, uploadId: string): Promise<PhotoView> {
    const upload = await this.#d.photos.findUpload(accountId, uploadId);
    if (!upload) throw new DomainError('not_found', MESSAGES.unknown);
    const key = uploadKey(uploadId);
    // Whatever happens next, the original never stays in quarantine.
    const discard = async () => {
      await this.#d.storage.deleteUpload(key);
      await this.#d.photos.deleteUpload(uploadId);
    };

    if (upload.expiresAt.getTime() + ABANDONED_GRACE_MS < this.#d.now().getTime()) {
      await discard();
      precondition(MESSAGES.expired);
    }
    const original = await this.#d.storage.readUpload(key, upload.byteLength);
    if (!original) precondition(MESSAGES.notUploaded);
    const data = original as Buffer;
    if (data.length !== upload.byteLength || !sniffType(data)) {
      await discard();
      invalid(MESSAGES.type);
    }

    let processed: Awaited<ReturnType<typeof processPhoto>>;
    try {
      processed = await processPhoto(data);
    } catch (error) {
      await discard();
      this.#d.logger.info({ accountId, uploadId }, LOG_REFUSED);
      throw error;
    }

    const photoId = this.#d.newId();
    await Promise.all(
      processed.variants.map((v) => this.#d.storage.putMedia(mediaKey(photoId, v.size), v.data)),
    );
    let result: Awaited<ReturnType<PhotoStore['add']>>;
    try {
      result = await this.#d.photos.add({
        id: photoId,
        accountId,
        width: processed.width,
        height: processed.height,
        moderation: 'pending',
      });
    } catch (error) {
      await this.#d.storage.deleteMedia(allSizes(photoId));
      throw error;
    }
    await discard();
    if (!('added' in result)) {
      await this.#d.storage.deleteMedia(allSizes(photoId));
      if ('full' in result) precondition(MESSAGES.full);
      throw new DomainError('not_found', MESSAGES.needsProfile);
    }

    const moderation = await this.#d.moderator.review({ id: photoId, accountId });
    if (moderation !== 'pending') await this.#d.photos.setModeration(photoId, moderation);
    this.#d.logger.info({ accountId, photoId }, LOG_ADDED);
    return this.#view({ ...result.added, moderation });
  }

  async listOwn(accountId: string): Promise<PhotoView[]> {
    return Promise.all((await this.#d.photos.list(accountId)).map((p) => this.#view(p)));
  }

  /** Approved photos of several members, grouped by member, in each member's order. */
  async approvedFor(accountIds: readonly string[]): Promise<Map<string, PhotoView[]>> {
    const byMember = new Map<string, PhotoView[]>();
    for (const photo of await this.#d.photos.approved(accountIds)) {
      const list = byMember.get(photo.accountId) ?? [];
      list.push(await this.#view(photo));
      byMember.set(photo.accountId, list);
    }
    return byMember;
  }

  async reorder(accountId: string, photoIds: readonly string[]): Promise<PhotoView[]> {
    if (!(await this.#d.photos.reorder(accountId, photoIds))) invalid(MESSAGES.order);
    this.#d.logger.info({ accountId }, LOG_REORDERED);
    return this.listOwn(accountId);
  }

  async remove(accountId: string, photoId: string): Promise<PhotoView[]> {
    if (!(await this.#d.photos.remove(accountId, photoId))) {
      throw new DomainError('not_found', MESSAGES.unknown);
    }
    await this.#d.storage.deleteMedia(allSizes(photoId));
    this.#d.logger.info({ accountId, photoId }, LOG_DELETED);
    return this.listOwn(accountId);
  }

  /** Deletes quarantine objects of uploads that were never completed (run periodically). */
  async clearAbandoned(limit = 50): Promise<number> {
    const before = new Date(this.#d.now().getTime() - ABANDONED_GRACE_MS);
    let cleared = 0;
    for (const upload of await this.#d.photos.expiredUploads(before, limit)) {
      try {
        await this.#d.storage.deleteUpload(uploadKey(upload.id));
        await this.#d.photos.deleteUpload(upload.id);
        cleared += 1;
        this.#d.logger.info({ uploadId: upload.id }, LOG_ABANDONED_CLEARED);
      } catch (err) {
        this.#d.logger.warn({ uploadId: upload.id, err }, LOG_ABANDONED_FAILED);
      }
    }
    return cleared;
  }

  async #view(photo: PhotoRecord): Promise<PhotoView> {
    // A photo smaller than a size was stored at its own size under that key; every key exists.
    const variants = await Promise.all(
      PHOTO_SIZES.map(async (size) => ({
        size: Math.min(size, Math.max(photo.width, photo.height)),
        url: await this.#d.storage.viewUrl(mediaKey(photo.id, size), VIEW_TTL_SECONDS),
      })),
    );
    return { ...photo, variants };
  }
}
