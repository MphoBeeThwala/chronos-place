import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3CaptureStore } from '../src/verification/s3-capture-store.js';

/** Records commands and keeps objects in a map, as S3 would. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const sent: object[] = [];
  const client = {
    send: (command: { input: { Bucket: string; Key: string; Body?: Buffer } }) => {
      sent.push(command);
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (command instanceof PutObjectCommand) objects.set(key, command.input.Body as Buffer);
      if (command instanceof DeleteObjectCommand) objects.delete(key);
      if (command instanceof GetObjectCommand) {
        const body = objects.get(key);
        if (!body) return Promise.reject(new NoSuchKey({ message: 'missing', $metadata: {} }));
        return Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(body) } });
      }
      return Promise.resolve({});
    },
  };
  return { client: client as unknown as S3Client, objects, sent };
}

describe('S3 capture store', () => {
  it('stores, reads back and deletes sealed captures, marked not to be cached', async () => {
    const s3 = fakeS3();
    const store = new S3CaptureStore(s3.client, 'captures');
    await store.put('verification/a', Buffer.from('sealed'));
    expect((s3.sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'captures',
      Key: 'verification/a',
      CacheControl: 'no-store',
    });
    expect((await store.get('verification/a'))?.toString()).toBe('sealed');
    await store.delete('verification/a');
    expect(await store.get('verification/a')).toBeUndefined();
    await expect(store.delete('verification/a')).resolves.toBeUndefined();
  });
});
