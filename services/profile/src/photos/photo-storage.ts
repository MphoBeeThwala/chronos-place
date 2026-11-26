import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Where photos live (ADR-0024 decisions a and d). Two private buckets:
 * - quarantine: raw uploads, written by the browser with a presigned PUT and deleted as soon as
 *   they are processed (and by a 1-day lifecycle rule as a backstop);
 * - media: processed WebP sizes only, under random keys, read through short-lived presigned GETs.
 */
/** A storage operation did not complete. The message never names files or members. */
export class PhotoStorageError extends Error {}

export interface PhotoStorage {
  /** A presigned PUT that accepts exactly this content type and byte length. */
  uploadUrl(
    key: string,
    contentType: string,
    byteLength: number,
    expiresInSeconds: number,
  ): Promise<string>;
  /** The raw upload, or undefined if it is missing or larger than `maxBytes`. */
  readUpload(key: string, maxBytes: number): Promise<Buffer | undefined>;
  deleteUpload(key: string): Promise<void>;
  putMedia(key: string, data: Buffer): Promise<void>;
  /** Idempotent. */
  deleteMedia(keys: readonly string[]): Promise<void>;
  /** A presigned GET for a processed size. */
  viewUrl(key: string, expiresInSeconds: number): Promise<string>;
}

/**
 * An S3 client fit for presigned browser uploads. By default the SDK adds a CRC32 of the (empty)
 * request body to presigned PUTs, which makes every real upload fail; checksums are therefore
 * only sent when an operation requires them.
 */
export function createS3Client(options: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}): S3Client {
  return new S3Client({
    region: options.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
}

export interface S3PhotoStorageOptions {
  /** Used for reads and writes from the service. Create it with createS3Client. */
  client: S3Client;
  /** Used to sign browser-facing links, when the browser reaches storage at another address. */
  publicClient?: S3Client;
  uploadBucket: string;
  mediaBucket: string;
}

export class S3PhotoStorage implements PhotoStorage {
  readonly #o: Required<S3PhotoStorageOptions>;

  constructor(options: S3PhotoStorageOptions) {
    this.#o = { publicClient: options.client, ...options };
  }

  uploadUrl(key: string, contentType: string, byteLength: number, expiresIn: number) {
    // Content type and length are signed: the link accepts nothing else.
    const command = new PutObjectCommand({
      Bucket: this.#o.uploadBucket,
      Key: key,
      ContentType: contentType,
      ContentLength: byteLength,
    });
    return getSignedUrl(this.#o.publicClient, command, {
      expiresIn,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  async readUpload(key: string, maxBytes: number): Promise<Buffer | undefined> {
    try {
      const object = await this.#o.client.send(
        new GetObjectCommand({ Bucket: this.#o.uploadBucket, Key: key }),
      );
      if ((object.ContentLength ?? 0) > maxBytes) return undefined;
      const bytes = await object.Body?.transformToByteArray();
      if (!bytes || bytes.length > maxBytes) return undefined;
      return Buffer.from(bytes);
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      throw err;
    }
  }

  async deleteUpload(key: string): Promise<void> {
    await this.#o.client.send(new DeleteObjectCommand({ Bucket: this.#o.uploadBucket, Key: key }));
  }

  async putMedia(key: string, data: Buffer): Promise<void> {
    await this.#o.client.send(
      new PutObjectCommand({
        Bucket: this.#o.mediaBucket,
        Key: key,
        Body: data,
        ContentType: 'image/webp',
        CacheControl: 'private, max-age=3600',
      }),
    );
  }

  async deleteMedia(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const result = await this.#o.client.send(
      new DeleteObjectsCommand({
        Bucket: this.#o.mediaBucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    // A batch delete reports failed keys in the response instead of throwing. Treat any as a
    // failure, so callers keep the rows that name the files and try again.
    if ((result.Errors?.length ?? 0) > 0) {
      throw new PhotoStorageError('some photo files could not be deleted');
    }
  }

  viewUrl(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.#o.publicClient,
      new GetObjectCommand({ Bucket: this.#o.mediaBucket, Key: key }),
      { expiresIn },
    );
  }
}

/** In-memory storage for development without SeaweedFS, and for tests. */
export class InMemoryPhotoStorage implements PhotoStorage {
  readonly uploads = new Map<string, Buffer>();
  readonly media = new Map<string, Buffer>();
  readonly issued: { key: string; contentType: string; byteLength: number }[] = [];

  uploadUrl(key: string, contentType: string, byteLength: number, expiresIn: number) {
    this.issued.push({ key, contentType, byteLength });
    return Promise.resolve(
      `https://storage.test/uploads/${key}?type=${encodeURIComponent(contentType)}&length=${String(byteLength)}&expires=${String(expiresIn)}`,
    );
  }

  readUpload(key: string, maxBytes: number) {
    const data = this.uploads.get(key);
    return Promise.resolve(data && data.length <= maxBytes ? data : undefined);
  }

  deleteUpload(key: string) {
    this.uploads.delete(key);
    return Promise.resolve();
  }

  putMedia(key: string, data: Buffer) {
    this.media.set(key, data);
    return Promise.resolve();
  }

  deleteMedia(keys: readonly string[]) {
    for (const key of keys) this.media.delete(key);
    return Promise.resolve();
  }

  viewUrl(key: string, expiresIn: number) {
    return Promise.resolve(`https://storage.test/media/${key}?expires=${String(expiresIn)}`);
  }
}
