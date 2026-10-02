import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  ReEncryptCommand,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import { KEY_LENGTH } from './cipher.js';
import { KeyUnwrapError } from './errors.js';
import {
  encryptionContext,
  type GeneratedKey,
  type KeyContext,
  type KeyWrapper,
} from './key-wrapper.js';

export interface KmsKeyWrapperOptions {
  /** Master key id, alias or ARN. Decrypt and re-encrypt are pinned to it. */
  keyId: string;
  /** Inject a client (tests) or let the wrapper build one from `clientConfig`. */
  client?: KMSClient;
  /** Region must be af-south-1 in deployed environments; @chronos/config enforces that. */
  clientConfig?: KMSClientConfig;
}

/**
 * Wraps data keys with AWS KMS. Needs only kms:GenerateDataKey, kms:Decrypt and kms:ReEncrypt*
 * on the master key. Every call carries an encryption context binding the key to its subject,
 * so a wrapped key copied to another subject cannot be unwrapped.
 */
export class KmsKeyWrapper implements KeyWrapper {
  readonly #client: KMSClient;
  readonly #keyId: string;

  constructor(options: KmsKeyWrapperOptions) {
    this.#keyId = options.keyId;
    this.#client = options.client ?? new KMSClient(options.clientConfig ?? {});
  }

  async generateDataKey(context: KeyContext): Promise<GeneratedKey> {
    try {
      const out = await this.#client.send(
        new GenerateDataKeyCommand({
          KeyId: this.#keyId,
          KeySpec: 'AES_256',
          EncryptionContext: encryptionContext(context),
        }),
      );
      if (!out.Plaintext || !out.CiphertextBlob || out.Plaintext.length !== KEY_LENGTH)
        throw new KeyUnwrapError();
      return {
        plaintext: out.Plaintext,
        wrapped: out.CiphertextBlob,
        keyId: out.KeyId ?? this.#keyId,
      };
    } catch {
      throw new KeyUnwrapError();
    }
  }

  async unwrap(wrapped: Uint8Array, context: KeyContext): Promise<Uint8Array> {
    try {
      const out = await this.#client.send(
        new DecryptCommand({
          KeyId: this.#keyId,
          CiphertextBlob: wrapped,
          EncryptionContext: encryptionContext(context),
        }),
      );
      if (!out.Plaintext || out.Plaintext.length !== KEY_LENGTH) throw new KeyUnwrapError();
      return out.Plaintext;
    } catch {
      throw new KeyUnwrapError();
    }
  }

  async rewrap(
    wrapped: Uint8Array,
    context: KeyContext,
  ): Promise<{ wrapped: Uint8Array; keyId: string }> {
    try {
      const ec = encryptionContext(context);
      const out = await this.#client.send(
        new ReEncryptCommand({
          CiphertextBlob: wrapped,
          SourceKeyId: this.#keyId,
          SourceEncryptionContext: ec,
          DestinationKeyId: this.#keyId,
          DestinationEncryptionContext: ec,
        }),
      );
      if (!out.CiphertextBlob) throw new KeyUnwrapError();
      return { wrapped: out.CiphertextBlob, keyId: out.KeyId ?? this.#keyId };
    } catch {
      throw new KeyUnwrapError();
    }
  }
}
