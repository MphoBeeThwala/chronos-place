import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3PhotoStorage } from '../src/photos/photo-storage.js';
import { startTestS3, type TestS3 } from './support/s3.js';

/** The S3 storage against SeaweedFS, the local S3 store (ADR-0013). */
let s3: TestS3;
let storage: S3PhotoStorage;
const run = Date.now().toString(36);
const key = (name: string) => `${run}/${name}`;

beforeAll(async () => {
  s3 = await startTestS3();
  storage = new S3PhotoStorage({
    client: s3.client,
    uploadBucket: s3.uploadBucket,
    mediaBucket: s3.mediaBucket,
  });
}, 120_000);

afterAll(async () => {
  await s3.stop();
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
