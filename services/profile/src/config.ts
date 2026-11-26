import { hostList, httpUrl, postgresUrl, secret } from '@chronos/config';
import { z } from 'zod';

/** The profile service's own settings, merged with the kit's (ADR-0023). */
/** Environments where photos may be kept in memory and auto-approved (ADR-0024). */
export const DEVELOPMENT_ENVIRONMENTS = ['local', 'test', 'development'] as const;

export const profileConfig = {
  DATABASE_URL: postgresUrl,
  /** host:port of the identity service, for members' ages and verified badges (ADR-0023 f). */
  /**
   * Kafka brokers (ADR-0019), locally Redpanda at 127.0.0.1:19092. Profile receives
   * account.erasure_requested and confirms with account.erasure_confirmed (ADR-0025). Unset:
   * erasure requests wait in Kafka until it is set.
   */
  KAFKA_BROKERS: hostList.optional(),
  IDENTITY_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .default('127.0.0.1:50052'),
  /** host:port of matching, for blocks (M3.1). Unreachable: no public profile is shown. */
  MATCHING_GRPC_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/)
    .default('127.0.0.1:50056'),

  /**
   * Photo storage (ADR-0024). Both buckets are private. Unset in development keeps photos in
   * memory; outside development they are required.
   */
  PHOTO_UPLOAD_BUCKET: z.string().min(3).optional(),
  PHOTO_MEDIA_BUCKET: z.string().min(3).optional(),
  /** SeaweedFS locally (http://127.0.0.1:8333); unset in AWS. */
  S3_ENDPOINT: httpUrl.optional(),
  /** Where browsers reach storage, when it differs from S3_ENDPOINT (signs upload and view links). */
  S3_PUBLIC_ENDPOINT: httpUrl.optional(),
  /** Static S3 credentials for SeaweedFS. Unset in AWS, which uses the service's role. */
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: secret(16).optional(),
};
