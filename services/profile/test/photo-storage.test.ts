import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { PhotoStorageError, S3PhotoStorage } from '../src/photos/photo-storage.js';

/** An S3 client that answers every request with `response`. */
const client = (response: unknown) =>
  ({ send: () => Promise.resolve(response) }) as unknown as S3Client;

const storage = (response: unknown) =>
  new S3PhotoStorage({ client: client(response), uploadBucket: 'u', mediaBucket: 'm' });

describe('S3PhotoStorage.deleteMedia', () => {
  it('fails when the batch delete reports any key it could not delete', async () => {
    // S3 answers 200 and lists failures in Errors instead of throwing.
    const partial = storage({ Errors: [{ Key: 'photos/p/320.webp', Code: 'AccessDenied' }] });
    await expect(partial.deleteMedia(['photos/p/320.webp'])).rejects.toBeInstanceOf(
      PhotoStorageError,
    );
  });

  it('succeeds when nothing failed, and never calls S3 for an empty list', async () => {
    await expect(storage({}).deleteMedia(['photos/p/320.webp'])).resolves.toBeUndefined();
    await expect(
      storage({ Errors: [] }).deleteMedia(['photos/p/320.webp']),
    ).resolves.toBeUndefined();
    const never = new S3PhotoStorage({
      client: { send: () => Promise.reject(new Error('called')) } as unknown as S3Client,
      uploadBucket: 'u',
      mediaBucket: 'm',
    });
    await expect(never.deleteMedia([])).resolves.toBeUndefined();
  });

  it('never names files in the error', async () => {
    const err = await storage({ Errors: [{ Key: 'photos/secret-id/320.webp' }] })
      .deleteMedia(['photos/secret-id/320.webp'])
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('secret-id');
  });
});
