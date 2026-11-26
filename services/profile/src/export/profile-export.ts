import type { Logger } from '@chronos/logger';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { profiles } from '../db/schema.js';
import type { PhotoService, PhotoView } from '../photos/photo.service.js';
import type { OwnProfileRecord } from '../profiles/profile-store.js';
import type { ProfileService } from '../profiles/profile.service.js';

/** Everything profile holds about a member, for "Download my data" (ADR-0025 c, i). */
export interface ProfileExport {
  own: OwnProfileRecord | undefined;
  /**
   * The stored location, already snapped to about 1 km. Only ever returned here, to the member
   * themselves (ADR-0025 i); never in the app and never to anyone else (CLAUDE.md rule 8).
   */
  location: { latitude: number; longitude: number; updatedAt: Date } | undefined;
  photos: PhotoView[];
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
}

export class ProfileExporter {
  readonly #d: {
    db: NodePgDatabase;
    profiles: ProfileService;
    photos: PhotoService;
    logger: Logger;
  };

  constructor(deps: {
    db: NodePgDatabase;
    profiles: ProfileService;
    photos: PhotoService;
    logger: Logger;
  }) {
    this.#d = deps;
  }

  async export(accountId: string): Promise<ProfileExport> {
    const [row] = await this.#d.db
      .select({
        createdAt: profiles.createdAt,
        updatedAt: profiles.updatedAt,
        latitude: sql<number | null>`ST_Y(${profiles.location}::geometry)`,
        longitude: sql<number | null>`ST_X(${profiles.location}::geometry)`,
        locationUpdatedAt: profiles.locationUpdatedAt,
      })
      .from(profiles)
      .where(eq(profiles.accountId, accountId));
    this.#d.logger.info({ accountId }, 'profile data exported');
    if (!row) {
      return {
        own: undefined,
        location: undefined,
        photos: [],
        createdAt: undefined,
        updatedAt: undefined,
      };
    }
    return {
      own: await this.#d.profiles.getOwn(accountId),
      location:
        row.latitude !== null && row.longitude !== null && row.locationUpdatedAt
          ? { latitude: row.latitude, longitude: row.longitude, updatedAt: row.locationUpdatedAt }
          : undefined,
      photos: await this.#d.photos.listForExport(accountId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
