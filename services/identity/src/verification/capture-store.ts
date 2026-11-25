/**
 * Where sealed captures are kept for the 30-day appeal window (ADR-0022). Object storage
 * (SeaweedFS locally, S3 in deployed environments) arrives with the vendor adapter; until then
 * development keeps captures in memory. Callers only ever store bytes already sealed under the
 * member's account key.
 */
export interface CaptureStore {
  put(key: string, sealed: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
}

export class InMemoryCaptureStore implements CaptureStore {
  readonly objects = new Map<string, Buffer>();

  put(key: string, sealed: Buffer): Promise<void> {
    this.objects.set(key, sealed);
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer | undefined> {
    return Promise.resolve(this.objects.get(key));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
