import { type EventPublisher, KafkaEventPublisher, KafkaEventSubscriber } from '@chronos/events';
import type { Logger } from '@chronos/logger';
import type { ReadinessRegistry, ServiceConfig } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { DEVELOPMENT_ENVIRONMENTS, type profileConfig } from './config.js';
import { IdentityMemberFacts, type MemberFacts } from './identity/member-facts.js';
import { ProfileEraser } from './erasure/profile-eraser.js';
import { every } from './maintenance/scheduler.js';
import {
  AutoApproveModerator,
  HoldForReviewModerator,
  type PhotoModerator,
} from './photos/moderator.js';
import {
  createS3Client,
  InMemoryPhotoStorage,
  type PhotoStorage,
  S3PhotoStorage,
} from './photos/photo-storage.js';
import { DrizzlePhotoStore } from './photos/photo-store.js';
import { PhotoService } from './photos/photo.service.js';
import { DrizzleProfileStore } from './profiles/profile-store.js';
import { ProfileService } from './profiles/profile.service.js';

export type ProfileConfig = ServiceConfig<typeof profileConfig>;

/** Without Kafka nothing consumes erasure requests, so nothing is ever published either. */
const NO_PUBLISHER: EventPublisher = {
  publish: () => Promise.reject(new Error('KAFKA_BROKERS is not set')),
};

export interface ProfileRuntime {
  profiles: ProfileService;
  photos: PhotoService;
  eraser: ProfileEraser;
  close: () => Promise<void>;
}

export interface RuntimeOverrides {
  /** Tests replace identity's member facts. */
  facts?: MemberFacts;
  /** Tests replace photo storage and the moderation hook. */
  photoStorage?: PhotoStorage;
  moderator?: PhotoModerator;
  /** Tests replace where erasure confirmations go. */
  publisher?: EventPublisher;
}

/** How often quarantine objects of abandoned uploads are cleared. */
export const ABANDONED_UPLOAD_SWEEP_MS = 60_000;

export class ProfileConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileConfigError';
  }
}

const isDevelopment = (env: string) =>
  (DEVELOPMENT_ENVIRONMENTS as readonly string[]).includes(env);

/**
 * Photo storage from config (ADR-0024). Development without buckets keeps photos in memory;
 * anywhere else both buckets are required.
 */
function photoStorage(
  config: ProfileConfig,
  development: boolean,
  logger: Logger,
): { storage: PhotoStorage; close: () => void } {
  const { PHOTO_UPLOAD_BUCKET: uploadBucket, PHOTO_MEDIA_BUCKET: mediaBucket } = config;
  if (uploadBucket === undefined || mediaBucket === undefined) {
    if (!development) {
      throw new ProfileConfigError('PHOTO_UPLOAD_BUCKET and PHOTO_MEDIA_BUCKET are required');
    }
    logger.warn('photos: kept in memory (development, no buckets configured)');
    return { storage: new InMemoryPhotoStorage(), close: () => undefined };
  }
  const credentials =
    config.S3_ACCESS_KEY_ID !== undefined && config.S3_SECRET_ACCESS_KEY !== undefined
      ? {
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY.reveal(),
        }
      : undefined;
  const client = createS3Client({
    region: config.AWS_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    ...(credentials ? { credentials } : {}),
  });
  const publicClient = config.S3_PUBLIC_ENDPOINT
    ? createS3Client({
        region: config.AWS_REGION,
        endpoint: config.S3_PUBLIC_ENDPOINT,
        ...(credentials ? { credentials } : {}),
      })
    : undefined;
  return {
    storage: new S3PhotoStorage({
      client,
      ...(publicClient ? { publicClient } : {}),
      uploadBucket,
      mediaBucket,
    }),
    close: () => {
      client.destroy();
      publicClient?.destroy();
    },
  };
}

/** Builds the service's dependencies from validated config. */
export function createProfileRuntime(
  config: ProfileConfig,
  logger: Logger,
  readiness: ReadinessRegistry,
  overrides: RuntimeOverrides = {},
): ProfileRuntime {
  const development = isDevelopment(config.NODE_ENV);
  // Checked before anything connects, so a misconfiguration fails fast.
  const media = overrides.photoStorage
    ? { storage: overrides.photoStorage, close: () => undefined }
    : photoStorage(config, development, logger);
  const moderator =
    overrides.moderator ??
    (development ? new AutoApproveModerator() : new HoldForReviewModerator());

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL.reveal(), max: 10 });
  readiness.register('postgres', async () => {
    await pool.query('select 1');
  });
  const db = drizzle(pool);
  const facts = overrides.facts ?? new IdentityMemberFacts(config.IDENTITY_GRPC_ADDRESS);
  const profiles = new ProfileService({ profiles: new DrizzleProfileStore(db), facts, logger });
  const photos = new PhotoService({
    photos: new DrizzlePhotoStore(db),
    storage: media.storage,
    moderator,
    logger,
  });
  // Account erasure (ADR-0025 d): requests arrive from identity; the confirmation goes back.
  const kafka = config.KAFKA_BROKERS
    ? {
        publisher: new KafkaEventPublisher({
          brokers: config.KAFKA_BROKERS,
          clientId: 'profile',
          logger,
        }),
        subscriber: new KafkaEventSubscriber({
          brokers: config.KAFKA_BROKERS,
          clientId: 'profile',
          logger,
        }),
      }
    : undefined;
  const eraser = new ProfileEraser({
    db,
    storage: media.storage,
    publisher: overrides.publisher ?? kafka?.publisher ?? NO_PUBLISHER,
    logger,
  });
  if (kafka) {
    kafka.subscriber.subscribe('account.erasure_requested', (event) => eraser.erase(event));
    // In the background: start-up stays synchronous. Unconsumed requests wait in Kafka.
    kafka.subscriber.start().catch((err: unknown) => {
      logger.error({ err }, 'erasure requests not consumed');
    });
  } else {
    logger.warn('erasure requests not consumed: KAFKA_BROKERS is not set (ADR-0025)');
  }
  const stopSweep = every(
    'abandoned-photo-uploads',
    ABANDONED_UPLOAD_SWEEP_MS,
    () => photos.clearAbandoned(),
    logger,
  );
  return {
    profiles,
    photos,
    eraser,
    close: async () => {
      await stopSweep();
      await kafka?.subscriber.close();
      await kafka?.publisher.close();
      facts.close();
      media.close();
      await pool.end();
    },
  };
}
