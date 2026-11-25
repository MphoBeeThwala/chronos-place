import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { CaptureStore } from './capture-store.js';

/**
 * Sealed captures in S3-compatible object storage: SeaweedFS locally (ADR-0013), S3 when deployed
 * (ADR-0022). Objects are already sealed under the member's account key, so the bucket only ever
 * holds ciphertext. Keys hold only the random attempt id. When the bucket is created in infra,
 * give it a lifecycle rule that expires objects after 31 days as a backstop to the worker.
 */
export class S3CaptureStore implements CaptureStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async put(key: string, sealed: Buffer): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: sealed,
        ContentType: 'application/octet-stream',
        CacheControl: 'no-store',
      }),
    );
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const object = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      const bytes = await object.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : undefined;
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 answers success for a missing key, so deletion is idempotent.
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
