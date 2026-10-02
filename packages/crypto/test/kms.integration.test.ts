import { CreateKeyCommand, DisableKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyDestroyedError, KeyUnwrapError, KmsKeyWrapper, SubjectKeyring } from '../src/index.js';
import { InMemoryWrappedKeyStore } from '../src/testing.js';

const MARKER = 'SYNTHETIC-MARKER-7f3a9c';
const context = { subjectId: 'subject-a', purpose: 'vault' };

let container: StartedLocalStackContainer;
let client: KMSClient;
let keyId: string;
let wrapper: KmsKeyWrapper;

async function createKey(): Promise<string> {
  const out = await client.send(
    new CreateKeyCommand({ KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' }),
  );
  const id = out.KeyMetadata?.KeyId;
  if (!id) throw new Error('key not created');
  return id;
}

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:4.9').start();
  client = new KMSClient({
    endpoint: container.getConnectionUri(),
    region: 'af-south-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  keyId = await createKey();
  wrapper = new KmsKeyWrapper({ keyId, client });
});

afterAll(async () => {
  client.destroy();
  await container.stop();
});

describe('KmsKeyWrapper against LocalStack KMS', () => {
  it('generates a 256-bit data key and unwraps it again', async () => {
    const generated = await wrapper.generateDataKey(context);
    expect(generated.plaintext).toHaveLength(32);
    expect(Buffer.from(generated.wrapped).includes(Buffer.from(generated.plaintext))).toBe(false);
    const unwrapped = await wrapper.unwrap(generated.wrapped, context);
    expect(Buffer.from(unwrapped).equals(Buffer.from(generated.plaintext))).toBe(true);
  });

  it('refuses to unwrap with a different encryption context (subject or purpose)', async () => {
    const generated = await wrapper.generateDataKey(context);
    await expect(
      wrapper.unwrap(generated.wrapped, { ...context, subjectId: 'subject-b' }),
    ).rejects.toThrow(KeyUnwrapError);
    await expect(
      wrapper.unwrap(generated.wrapped, { ...context, purpose: 'other' }),
    ).rejects.toThrow(KeyUnwrapError);
  });

  it('refuses to unwrap through a wrapper pinned to another master key', async () => {
    const generated = await wrapper.generateDataKey(context);
    const other = new KmsKeyWrapper({ keyId: await createKey(), client });
    await expect(other.unwrap(generated.wrapped, context)).rejects.toThrow(KeyUnwrapError);
  });

  it('rewraps without changing the data key', async () => {
    const generated = await wrapper.generateDataKey(context);
    const rewrapped = await wrapper.rewrap(generated.wrapped, context);
    expect(Buffer.from(rewrapped.wrapped).equals(Buffer.from(generated.wrapped))).toBe(false);
    const unwrapped = await wrapper.unwrap(rewrapped.wrapped, context);
    expect(Buffer.from(unwrapped).equals(Buffer.from(generated.plaintext))).toBe(true);
  });

  it('fails with a generic error when KMS is unreachable', async () => {
    const dead = new KmsKeyWrapper({
      keyId,
      client: new KMSClient({
        endpoint: 'http://127.0.0.1:1',
        region: 'af-south-1',
        credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
        maxAttempts: 1,
      }),
    });
    await expect(dead.generateDataKey(context)).rejects.toThrow(KeyUnwrapError);
  });
});

describe('SubjectKeyring with KMS', () => {
  it('encrypts, then crypto-shreds so the data cannot be recovered', async () => {
    const store = new InMemoryWrappedKeyStore();
    const keyring = new SubjectKeyring({ wrapper, store, cacheTtlMs: 0 });
    const sealed = await keyring.encrypt('subject-shred', 'payload', { conditions: [MARKER] });
    expect(await keyring.decrypt('subject-shred', 'payload', sealed)).toEqual({
      conditions: [MARKER],
    });

    await keyring.shred('subject-shred');

    await expect(keyring.decrypt('subject-shred', 'payload', sealed)).rejects.toThrow(
      KeyDestroyedError,
    );
  });

  it('stops decrypting when the master key is disabled (KMS-side revocation)', async () => {
    const ownKey = await createKey();
    const store = new InMemoryWrappedKeyStore();
    const keyring = new SubjectKeyring({
      wrapper: new KmsKeyWrapper({ keyId: ownKey, client }),
      store,
      cacheTtlMs: 0,
    });
    const sealed = await keyring.encrypt('subject-d', 'payload', { v: 1 });
    await client.send(new DisableKeyCommand({ KeyId: ownKey }));
    await expect(keyring.decrypt('subject-d', 'payload', sealed)).rejects.toThrow(KeyUnwrapError);
  });
});
