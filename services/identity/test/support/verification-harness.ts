import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper, InMemoryWrappedKeyStore } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import type { AccountRecord } from '../../src/accounts/account-store.js';
import type { AccountStatus } from '../../src/db/schema.js';
import { IDENTITY_KEY_PURPOSE } from '../../src/otp/otp.service.js';
import type { LivenessCapture } from '../../src/verification/capture.js';
import { InMemoryCaptureStore } from '../../src/verification/capture-store.js';
import { FakeLivenessProvider } from '../../src/verification/provider.js';
import { VerificationService } from '../../src/verification/verification.service.js';
import { VerificationWorker } from '../../src/verification/verification-worker.js';
import { InMemoryVerificationStore } from './verification-fakes.js';

export const ACCOUNT = '22222222-2222-4222-8222-222222222222';

/** A synthetic JPEG: the magic bytes plus a recognisable filler, never a real face. */
export const jpeg = (tag: string, size = 2_000) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, tag)]);

export const capture = (): LivenessCapture => ({
  selfie: jpeg('S'),
  frames: [jpeg('A'), jpeg('B'), jpeg('C')],
});

export function setup(
  options: {
    status?: AccountStatus;
    consent?: boolean;
    provider?: boolean;
    logs?: { write: (l: string) => void };
  } = {},
) {
  let clock = Date.parse('2026-11-25T10:00:00Z');
  const now = () => new Date(clock);
  const store = new InMemoryVerificationStore(now);
  const captures = new InMemoryCaptureStore();
  const provider = new FakeLivenessProvider();
  const keyring = new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store: new InMemoryWrappedKeyStore(),
    purpose: IDENTITY_KEY_PURPOSE,
    cacheTtlMs: 0,
  });
  let consent = options.consent ?? true;
  const logger = createLogger({
    service: 'identity-test',
    level: 'trace',
    destination: options.logs ?? { write: () => undefined },
  });
  const account = (): AccountRecord => ({
    id: ACCOUNT,
    status: options.status ?? 'active',
    hasDateOfBirth: true,
    verified: store.verified.has(ACCOUNT),
  });
  const service = new VerificationService({
    store,
    captures,
    provider: options.provider === false ? undefined : provider,
    keyring,
    getAccount: () => Promise.resolve(account()),
    hasConsent: () => Promise.resolve(consent),
    logger,
    now,
  });
  const worker = new VerificationWorker({ store, captures, provider, keyring, logger, now });
  return {
    service,
    worker,
    store,
    captures,
    provider,
    keyring,
    advance: (ms: number) => {
      clock += ms;
    },
    withdrawConsent: () => {
      consent = false;
    },
  };
}
