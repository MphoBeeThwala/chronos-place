import { CreateBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@chronos/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createS3Client, S3PhotoStorage } from '../src/photos/photo-storage.js';

/**
 * The S3 storage against SeaweedFS, the local S3 store (ADR-0013). Uses TEST_S3_ENDPOINT when
 * set (with TEST_S3_ACCESS_KEY and TEST_S3_SECRET_KEY), otherwise starts SeaweedFS in Docker.
 */
let container: StartedTestContainer | undefined;
let client: S3Client;
let storage: S3PhotoStorage;
const env = loadConfig(
  z.object({
    TEST_S3_ENDPOINT: z.string().optional(),
    TEST_S3_ACCESS_KEY: z.string().default('synthetictestkey'),
    TEST_S3_SECRET_KEY: z.string().default('synthetictestsecretvalue0123456789'),
  }),
);
const ACCESS = env.TEST_S3_ACCESS_KEY;
const SECRET = env.TEST_S3_SECRET_KEY;
// Fixed buckets (SeaweedFS reserves volumes per bucket) and a fresh key prefix per run.
const uploadBucket = 'test-photo-uploads';
const mediaBucket = 'test-photo-media';
const run = Date.now().toString(36);
const key = (name: string) => `${run}/${name}`;

beforeAll(async () => {
  let endpoint = env.TEST_S3_ENDPOINT;
  if (!endpoint) {
    container = await new GenericContainer('chrislusf/seaweedfs:4.01')
      .withCommand(['server', '-s3', '-s3.port=8333', '-ip.bind=0.0.0.0'])
      .withEnvironment({ AWS_ACCESS_KEY_ID: ACCESS, AWS_SECRET_ACCESS_KEY: SECRET })
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    endpoint = `http://${container.getHost()}:${String(container.getMappedPort(8333))}`;
  }
  client = createS3Client({
    endpoint,
    region: 'af-south-1',
    credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  });
  for (const Bucket of [uploadBucket, mediaBucket]) {
    await client.send(new CreateBucketCommand({ Bucket })).catch((error: unknown) => {
      const name = (error as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
    });
  }
  storage = new S3PhotoStorage({ client, uploadBucket, mediaBucket });
}, 120_000);

afterAll(async () => {
  client.destroy();
  await container?.stop();
});

const jpegish = (size: number) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(size - 3, 1)]);

describe('presigned uploads (ADR-0024 decision a)', () => {
  it('accept exactly the signed type and length, and nothing else', async () => {
    const body = jpegish(4_000);
    const url = await storage.uploadUrl(key('uploads/a'), 'image/jpeg', body.length, 300);
    expect(new URL(url).search).toContain('X-Amz-Signature');

    const wrongType = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body,
    });
    expect(wrongType.ok).toBe(false);
    const wrongLength = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.concat([body, Buffer.alloc(10)]),
    });
    expect(wrongLength.ok).toBe(false);

    const ok = await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body });
    expect(ok.status).toBe(200);
    expect((await storage.readUpload(key('uploads/a'), 10_000))?.equals(body)).toBe(true);
  });

  it('reads nothing that is missing or over the size cap, and deletes uploads', async () => {
    const body = jpegish(2_000);
    const url = await storage.uploadUrl(key('uploads/b'), 'image/jpeg', body.length, 300);
    await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body });
    expect(await storage.readUpload(key('uploads/b'), 1_000)).toBeUndefined();
    expect(await storage.readUpload(key('uploads/missing'), 1_000)).toBeUndefined();
    await storage.deleteUpload(key('uploads/b'));
    expect(await storage.readUpload(key('uploads/b'), 10_000)).toBeUndefined();
  });
});

describe('media (decision d)', () => {
  it('serves processed sizes through signed links only, and deletes them', async () => {
    const data = Buffer.from('RIFF0000WEBPsynthetic');
    await storage.putMedia(key('photos/p1/320.webp'), data);
    const url = await storage.viewUrl(key('photos/p1/320.webp'), 3600);
    const signed = await fetch(url);
    expect(signed.status).toBe(200);
    expect(Buffer.from(await signed.arrayBuffer()).equals(data)).toBe(true);

    const unsigned = await fetch(url.split('?')[0] ?? url);
    expect(unsigned.ok).toBe(false);

    await storage.deleteMedia([key('photos/p1/320.webp'), key('photos/p1/never-existed.webp')]);
    expect((await fetch(await storage.viewUrl(key('photos/p1/320.webp'), 3600))).ok).toBe(false);
  });
});
