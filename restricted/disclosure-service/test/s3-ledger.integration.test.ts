import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@chronos/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NOT_ERASED_CACHE_MS, S3ErasureLedger } from '../src/vault/s3-ledger.js';

/**
 * The erasure ledger against SeaweedFS, the local S3 store (ADR-0013). TEST_S3_ENDPOINT (with
 * TEST_S3_ACCESS_KEY and TEST_S3_SECRET_KEY) or SeaweedFS in Docker.
 */
let client: S3Client;
let container: StartedTestContainer | undefined;
const BUCKET = 'test-erasure-ledger';

beforeAll(async () => {
  const env = loadConfig(
    z.object({
      TEST_S3_ENDPOINT: z.string().optional(),
      TEST_S3_ACCESS_KEY: z.string().default('synthetictestkey'),
      TEST_S3_SECRET_KEY: z.string().default('synthetictestsecretvalue0123456789'),
    }),
  );
  let endpoint = env.TEST_S3_ENDPOINT;
  if (!endpoint) {
    container = await new GenericContainer('chrislusf/seaweedfs:4.01')
      .withCommand(['server', '-s3', '-s3.port=8333', '-ip.bind=0.0.0.0'])
      .withEnvironment({
        AWS_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_KEY,
      })
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    endpoint = `http://${container.getHost()}:${String(container.getMappedPort(8333))}`;
  }
  client = new S3Client({
    region: 'af-south-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: env.TEST_S3_ACCESS_KEY, secretAccessKey: env.TEST_S3_SECRET_KEY },
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((error: unknown) => {
    const name = (error as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
  });
}, 120_000);

afterAll(async () => {
  client.destroy();
  await container?.stop();
});

describe('S3ErasureLedger', () => {
  it('records once, answers from S3, and lists entries', async () => {
    const ledger = new S3ErasureLedger({ client, bucket: BUCKET });
    const erased = randomUUID();
    const kept = randomUUID();
    await ledger.record(erased);
    await ledger.record(erased); // write-once: a second record is not an error

    // A fresh instance (another replica) sees it in S3, not just in memory.
    const other = new S3ErasureLedger({ client, bucket: BUCKET });
    expect(await other.isShredded(erased)).toBe(true);
    expect(await other.isShredded(kept)).toBe(false);
    const listed: string[] = [];
    for await (const id of other.list()) listed.push(id);
    expect(listed).toContain(erased);
    expect(listed).not.toContain(kept);
    await expect(other.ready()).resolves.toBeUndefined();
  });

  it('remembers "not erased" only briefly', async () => {
    let now = 0;
    const replica = new S3ErasureLedger({ client, bucket: BUCKET, now: () => now });
    const id = randomUUID();
    expect(await replica.isShredded(id)).toBe(false);
    await new S3ErasureLedger({ client, bucket: BUCKET }).record(id); // erased elsewhere
    expect(await replica.isShredded(id)).toBe(false); // still within the cache window
    now += NOT_ERASED_CACHE_MS;
    expect(await replica.isShredded(id)).toBe(true);
  });

  it('refuses anything but a vault id, and fails closed without its bucket', async () => {
    const ledger = new S3ErasureLedger({ client, bucket: BUCKET });
    await expect(ledger.record('../etc')).rejects.toThrow(/vault id/);
    const missing = new S3ErasureLedger({ client, bucket: 'no-such-ledger-bucket' });
    await expect(missing.ready()).rejects.toBeDefined();
  });
});
