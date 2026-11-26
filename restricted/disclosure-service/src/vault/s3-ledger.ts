import {
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ShredLedger } from '@chronos/crypto';

/** A ledger that can also list every entry, for the restore replay (ADR-0014 step 4). */
export interface ErasureLedger extends ShredLedger {
  list(): AsyncIterable<string>;
  ready(): Promise<void>;
}

const PREFIX = 'erased/';
const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * How long "not erased" may be remembered. No longer than the keyring may keep a data key in
 * memory (60 s), so a subject erased by another replica stops working within the same window.
 * "Erased" is remembered for good.
 */
export const NOT_ERASED_CACHE_MS = 30_000;

export function createLedgerClient(options: {
  region: string;
  endpoint?: string | undefined;
}): S3Client {
  return new S3Client({
    region: options.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  });
}

/**
 * The erasure ledger (ADR-0014): one empty, write-once object per erased subject,
 * `erased/<vault id>`, in a bucket outside the vault database and its backups. In deployed
 * environments the bucket has Object Lock, so entries cannot be deleted or overwritten. It holds
 * pseudonymous vault ids only, never account ids or health data.
 */
export class S3ErasureLedger implements ErasureLedger {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #now: () => number;
  readonly #erased = new Set<string>();
  readonly #notErased = new Map<string, number>();

  constructor(options: { client: S3Client; bucket: string; now?: () => number }) {
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#now = options.now ?? Date.now;
  }

  async record(vaultId: string): Promise<void> {
    this.#assertId(vaultId);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: PREFIX + vaultId,
          Body: new Uint8Array(0),
          ContentLength: 0,
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      // Already recorded (write-once): that is the state we want.
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412
      ) {
        throw error;
      }
    }
    this.#erased.add(vaultId);
    this.#notErased.delete(vaultId);
  }

  async isShredded(vaultId: string): Promise<boolean> {
    if (this.#erased.has(vaultId)) return true;
    const checked = this.#notErased.get(vaultId);
    if (checked !== undefined && this.#now() - checked < NOT_ERASED_CACHE_MS) return false;
    try {
      await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: PREFIX + vaultId }),
      );
      this.#erased.add(vaultId);
      return true;
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        this.#notErased.set(vaultId, this.#now());
        return false;
      }
      throw error; // fail closed: the keyring refuses to use the key
    }
  }

  async *list(): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: PREFIX,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        const id = object.Key?.slice(PREFIX.length);
        if (id !== undefined && VAULT_ID.test(id)) yield id;
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async ready(): Promise<void> {
    await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
  }

  #assertId(vaultId: string): void {
    if (!VAULT_ID.test(vaultId)) throw new Error('not a vault id');
  }
}
