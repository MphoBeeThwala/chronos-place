import { createEvent, type EventOf } from '@chronos/contracts/events';
import type { EventPublisher } from '@chronos/events';
import type { Logger } from '@chronos/logger';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { photoUploads, profilePhotos, profiles } from '../db/schema.js';
import { allSizes, uploadKey } from '../photos/photo.service.js';
import type { PhotoStorage } from '../photos/photo-storage.js';

export interface ProfileEraserDeps {
  db: NodePgDatabase;
  storage: PhotoStorage;
  publisher: EventPublisher;
  logger: Logger;
}

/**
 * Deletes everything profile holds for a member when their account is being erased (spec 7,
 * ADR-0025 d), then confirms with account.erasure_confirmed. Files go first, rows second: if a
 * file delete fails, the rows that name the files are still there for the retry, so nothing is
 * ever left in storage without a record of it. Every step is safe to repeat, so a redelivered
 * event just confirms again.
 */
export class ProfileEraser {
  readonly #d: ProfileEraserDeps;

  constructor(deps: ProfileEraserDeps) {
    this.#d = deps;
  }

  async erase(event: EventOf<'account.erasure_requested'>): Promise<void> {
    const { accountId } = event.data;
    const { db, storage } = this.#d;
    const photos = await db
      .select({ id: profilePhotos.id })
      .from(profilePhotos)
      .where(eq(profilePhotos.accountId, accountId));
    const uploads = await db
      .select({ id: photoUploads.id })
      .from(photoUploads)
      .where(eq(photoUploads.accountId, accountId));

    // Every size of every photo, then any upload still waiting in quarantine.
    await storage.deleteMedia(photos.flatMap((p) => allSizes(p.id)));
    for (const upload of uploads) await storage.deleteUpload(uploadKey(upload.id));

    // The profile row cascades to prompts, interests, preferences, uploads and photos.
    await db.delete(profiles).where(eq(profiles.accountId, accountId));

    const confirmed = createEvent('account.erasure_confirmed', 'profile', {
      accountId,
      service: 'profile',
    });
    await this.#d.publisher.publish(confirmed.type, accountId, confirmed);
    this.#d.logger.info(
      { accountId, photos: photos.length, uploads: uploads.length },
      'profile data erased',
    );
  }
}
