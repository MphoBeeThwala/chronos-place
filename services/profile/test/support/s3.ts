import { CreateBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@chronos/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { z } from 'zod';
import { createS3Client } from '../../src/photos/photo-storage.js';

export interface TestS3 {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  uploadBucket: string;
  mediaBucket: string;
  client: S3Client;
  stop: () => Promise<void>;
}

/**
 * SeaweedFS, the local S3 store (ADR-0013). Uses TEST_S3_ENDPOINT when set (with
 * TEST_S3_ACCESS_KEY and TEST_S3_SECRET_KEY), otherwise starts SeaweedFS in Docker. The buckets
 * are fixed (SeaweedFS reserves volumes per bucket); keys must be unique per run.
 */
export async function startTestS3(): Promise<TestS3> {
  const env = loadConfig(
    z.object({
      TEST_S3_ENDPOINT: z.string().optional(),
      TEST_S3_ACCESS_KEY: z.string().default('synthetictestkey'),
      TEST_S3_SECRET_KEY: z.string().default('synthetictestsecretvalue0123456789'),
    }),
  );
  const accessKeyId = env.TEST_S3_ACCESS_KEY;
  const secretAccessKey = env.TEST_S3_SECRET_KEY;
  let container: StartedTestContainer | undefined;
  let endpoint = env.TEST_S3_ENDPOINT;
  if (!endpoint) {
    container = await new GenericContainer('chrislusf/seaweedfs:4.01')
      .withCommand(['server', '-s3', '-s3.port=8333', '-ip.bind=0.0.0.0'])
      .withEnvironment({ AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey })
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    endpoint = `http://${container.getHost()}:${String(container.getMappedPort(8333))}`;
  }
  const client = createS3Client({
    endpoint,
    region: 'af-south-1',
    credentials: { accessKeyId, secretAccessKey },
  });
  const uploadBucket = 'test-photo-uploads';
  const mediaBucket = 'test-photo-media';
  for (const Bucket of [uploadBucket, mediaBucket]) {
    await client.send(new CreateBucketCommand({ Bucket })).catch((error: unknown) => {
      const name = (error as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
    });
  }
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    uploadBucket,
    mediaBucket,
    client,
    stop: async () => {
      client.destroy();
      await container?.stop();
    },
  };
}
