import { DecryptionError, KeyDestroyedError, SubjectKeyring } from '@chronos/crypto';
import {
  InMemoryKeyWrapper,
  InMemoryShredLedger,
  InMemoryWrappedKeyStore,
} from '@chronos/crypto/testing';
import { describe, expect, it } from 'vitest';
import { createPrivacyHarness, TextSink } from '../src/index.js';
import { usePrivacyHarness } from '../src/vitest.js';

const SUBJECT = '44444444-4444-4444-8444-444444444444';

const setup = () => {
  const store = new InMemoryWrappedKeyStore();
  const keyring = new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store,
    ledger: new InMemoryShredLedger(),
    cacheTtlMs: 0,
  });
  return { store, keyring };
};

describe('envelope encryption keeps plaintext out of everything it produces', () => {
  const privacy = usePrivacyHarness();

  it('stored values (ciphertext, nonce, wrapped key) contain no plaintext in any encoding', async () => {
    // What a database row holds. Not a log or an event: ciphertext is never published either (rule 3).
    const database = new TextSink('database');
    privacy.addSink(database);
    const { store, keyring } = setup();
    const payload = {
      conditions: [{ code: privacy.markers.conditionCode(), status: 'living_with' }],
      freeText: privacy.markers.healthText(),
      note: privacy.markers.email(),
    };
    const sealed = await keyring.encrypt(SUBJECT, 'payload', payload);
    const record = await store.get(SUBJECT);
    database.capture(`ct=${Buffer.from(sealed.ciphertext).toString('base64')}`);
    database.capture(`ct-hex=${Buffer.from(sealed.ciphertext).toString('hex')}`);
    database.capture(`nonce=${Buffer.from(sealed.nonce).toString('hex')}`);
    database.capture(`wrapped=${Buffer.from(record?.wrapped ?? []).toString('base64')}`);
    expect(await keyring.decrypt(SUBJECT, 'payload', sealed)).toEqual(payload);
  });

  it('errors from tampering, wrong fields and shredding say nothing about the data', async () => {
    const { keyring } = setup();
    const sealed = await keyring.encrypt(SUBJECT, 'payload', {
      freeText: privacy.markers.healthText(),
    });
    const failures: unknown[] = [];
    await keyring.decrypt(SUBJECT, 'other-field', sealed).catch((e: unknown) => failures.push(e));
    await keyring
      .decrypt(SUBJECT, 'payload', { ...sealed, nonce: new Uint8Array(12) })
      .catch((e: unknown) => failures.push(e));
    await keyring.shred(SUBJECT);
    await keyring.decrypt(SUBJECT, 'payload', sealed).catch((e: unknown) => failures.push(e));

    expect(failures.map((f) => (f as Error).constructor)).toEqual([
      DecryptionError,
      DecryptionError,
      KeyDestroyedError,
    ]);
    for (const failure of failures) {
      const error = failure as Error;
      privacy.grpc.recordError({ code: 13, details: error.message, message: String(error) });
      privacy.logs.destination.write(
        JSON.stringify({ err: error.message, json: JSON.stringify(error), stack: error.stack }),
      );
    }
  });
});

describe('the harness would notice if plaintext were logged', () => {
  it('flags the plaintext payload (guards against a blind spot with JSON quoting)', () => {
    const harness = createPrivacyHarness({ seed: 'crypto-control' });
    const payload = {
      conditions: [{ code: harness.markers.conditionCode() }],
      freeText: harness.markers.healthText(),
    };
    harness.logs.destination.write(
      `${JSON.stringify({ msg: 'saving', payload: JSON.stringify(payload) })}\n`,
    );
    expect(harness.scan().filter((f) => f.type === 'marker')).toHaveLength(2);
  });
});
