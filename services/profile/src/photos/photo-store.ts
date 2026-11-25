import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type PhotoModeration, photoUploads, profilePhotos, profiles } from '../db/schema.js';

/** Up to 6 photos per member (PRD, ADR-0024 decision f). */
export const MAX_PHOTOS = 6;

export interface PhotoRecord {
  id: string;
  accountId: string;
  position: number;
  width: number;
  height: number;
  moderation: PhotoModeration;
}

export interface UploadRecord {
  id: string;
  accountId: string;
  contentType: string;
  byteLength: number;
  expiresAt: Date;
}

export type AddResult = { added: PhotoRecord } | { full: true } | { noProfile: true };

export interface PhotoStore {
  hasProfile(accountId: string): Promise<boolean>;
  count(accountId: string): Promise<number>;
  /** Unexpired uploads the member has not completed. */
  openUploads(accountId: string, now: Date): Promise<number>;
  insertUpload(upload: UploadRecord): Promise<void>;
  /** The member's own upload, expired or not. Undefined for anyone else's. */
  findUpload(accountId: string, uploadId: string): Promise<UploadRecord | undefined>;
  deleteUpload(uploadId: string): Promise<void>;
  /** Uploads that expired before `before`, oldest first. */
  expiredUploads(before: Date, limit: number): Promise<UploadRecord[]>;
  /** Adds the photo last, under a lock on the profile so two completions cannot both take slot 6. */
  add(photo: Omit<PhotoRecord, 'position'>): Promise<AddResult>;
  setModeration(photoId: string, moderation: PhotoModeration): Promise<void>;
  list(accountId: string): Promise<PhotoRecord[]>;
  /** Approved photos of several members, in their order. */
  approved(accountIds: readonly string[]): Promise<PhotoRecord[]>;
  /** Sets positions to the order given; false unless the ids are exactly the member's photos. */
  reorder(accountId: string, photoIds: readonly string[]): Promise<boolean>;
  /** Deletes the photo and closes the gap in positions. False when it is not the member's. */
  remove(accountId: string, photoId: string): Promise<boolean>;
}

const photoColumns = {
  id: profilePhotos.id,
  accountId: profilePhotos.accountId,
  position: profilePhotos.position,
  width: profilePhotos.width,
  height: profilePhotos.height,
  moderation: profilePhotos.moderation,
};

const uploadColumns = {
  id: photoUploads.id,
  accountId: photoUploads.accountId,
  contentType: photoUploads.contentType,
  byteLength: photoUploads.byteLength,
  expiresAt: photoUploads.expiresAt,
};

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/** Serialises changes to one member's photos. */
async function lockProfile(tx: Tx, accountId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: profiles.accountId })
    .from(profiles)
    .where(eq(profiles.accountId, accountId))
    .for('update');
  return rows.length > 0;
}

export class DrizzlePhotoStore implements PhotoStore {
  readonly #db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this.#db = db;
  }

  async hasProfile(accountId: string): Promise<boolean> {
    const rows = await this.#db
      .select({ id: profiles.accountId })
      .from(profiles)
      .where(eq(profiles.accountId, accountId));
    return rows.length > 0;
  }

  async count(accountId: string): Promise<number> {
    const [row] = await this.#db
      .select({ n: sql<number>`count(*)::int` })
      .from(profilePhotos)
      .where(eq(profilePhotos.accountId, accountId));
    return row?.n ?? 0;
  }

  async openUploads(accountId: string, now: Date): Promise<number> {
    const [row] = await this.#db
      .select({ n: sql<number>`count(*)::int` })
      .from(photoUploads)
      .where(and(eq(photoUploads.accountId, accountId), gt(photoUploads.expiresAt, now)));
    return row?.n ?? 0;
  }

  async insertUpload(upload: UploadRecord): Promise<void> {
    await this.#db.insert(photoUploads).values(upload);
  }

  async findUpload(accountId: string, uploadId: string): Promise<UploadRecord | undefined> {
    const [row] = await this.#db
      .select(uploadColumns)
      .from(photoUploads)
      .where(and(eq(photoUploads.id, uploadId), eq(photoUploads.accountId, accountId)));
    return row;
  }

  async deleteUpload(uploadId: string): Promise<void> {
    await this.#db.delete(photoUploads).where(eq(photoUploads.id, uploadId));
  }

  expiredUploads(before: Date, limit: number): Promise<UploadRecord[]> {
    return this.#db
      .select(uploadColumns)
      .from(photoUploads)
      .where(lte(photoUploads.expiresAt, before))
      .orderBy(asc(photoUploads.expiresAt))
      .limit(limit);
  }

  add(photo: Omit<PhotoRecord, 'position'>): Promise<AddResult> {
    return this.#db.transaction(async (tx) => {
      if (!(await lockProfile(tx, photo.accountId))) return { noProfile: true } as const;
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(profilePhotos)
        .where(eq(profilePhotos.accountId, photo.accountId));
      const position = row?.n ?? 0;
      if (position >= MAX_PHOTOS) return { full: true } as const;
      await tx.insert(profilePhotos).values({ ...photo, position });
      return { added: { ...photo, position } };
    });
  }

  async setModeration(photoId: string, moderation: PhotoModeration): Promise<void> {
    await this.#db.update(profilePhotos).set({ moderation }).where(eq(profilePhotos.id, photoId));
  }

  list(accountId: string): Promise<PhotoRecord[]> {
    return this.#db
      .select(photoColumns)
      .from(profilePhotos)
      .where(eq(profilePhotos.accountId, accountId))
      .orderBy(asc(profilePhotos.position));
  }

  approved(accountIds: readonly string[]): Promise<PhotoRecord[]> {
    if (accountIds.length === 0) return Promise.resolve([]);
    return this.#db
      .select(photoColumns)
      .from(profilePhotos)
      .where(
        and(
          inArray(profilePhotos.accountId, [...accountIds]),
          eq(profilePhotos.moderation, 'approved'),
        ),
      )
      .orderBy(asc(profilePhotos.accountId), asc(profilePhotos.position));
  }

  reorder(accountId: string, photoIds: readonly string[]): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      if (!(await lockProfile(tx, accountId))) return false;
      const current = await tx
        .select({ id: profilePhotos.id })
        .from(profilePhotos)
        .where(eq(profilePhotos.accountId, accountId));
      const ids = new Set(current.map((r) => r.id));
      if (photoIds.length !== ids.size || new Set(photoIds).size !== ids.size) return false;
      if (!photoIds.every((id) => ids.has(id))) return false;
      for (const [position, id] of photoIds.entries()) {
        await tx.update(profilePhotos).set({ position }).where(eq(profilePhotos.id, id));
      }
      return true;
    });
  }

  remove(accountId: string, photoId: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      if (!(await lockProfile(tx, accountId))) return false;
      const deleted = await tx
        .delete(profilePhotos)
        .where(and(eq(profilePhotos.id, photoId), eq(profilePhotos.accountId, accountId)))
        .returning({ position: profilePhotos.position });
      const [gone] = deleted;
      if (!gone) return false;
      await tx
        .update(profilePhotos)
        .set({ position: sql`${profilePhotos.position} - 1` })
        .where(
          and(eq(profilePhotos.accountId, accountId), gt(profilePhotos.position, gone.position)),
        );
      return true;
    });
  }
}
