/** What a wrapped key is bound to. Passed to KMS as the encryption context. */
export interface KeyContext {
  subjectId: string;
  purpose: string;
}

export interface GeneratedKey {
  /** 32-byte data key. Hold it only as long as needed and zero it afterwards. */
  plaintext: Uint8Array;
  /** The same key, wrapped by the master key. Safe to store. */
  wrapped: Uint8Array;
  /** Identifier of the master key that wrapped it. */
  keyId: string;
}

/**
 * Provider-neutral key wrapping (ADR-0011). AWS KMS is the production implementation;
 * moving clouds means writing another implementation, not touching vault code.
 */
export interface KeyWrapper {
  generateDataKey(context: KeyContext): Promise<GeneratedKey>;
  unwrap(wrapped: Uint8Array, context: KeyContext): Promise<Uint8Array>;
  /** Re-wraps under the current master key without exposing the data key. */
  rewrap(wrapped: Uint8Array, context: KeyContext): Promise<{ wrapped: Uint8Array; keyId: string }>;
}

export const CONTEXT_VERSION = '1';

export function encryptionContext(context: KeyContext): Record<string, string> {
  return { subject: context.subjectId, purpose: context.purpose, v: CONTEXT_VERSION };
}
