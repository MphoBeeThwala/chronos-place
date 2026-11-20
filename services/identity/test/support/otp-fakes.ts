import { randomBytes } from 'node:crypto';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper, InMemoryWrappedKeyStore } from '@chronos/crypto/testing';
import { createLogger, type Logger } from '@chronos/logger';
import type {
  ChallengeStore,
  NewChallenge,
  StoredChallenge,
} from '../../src/otp/challenge-store.js';
import { CodeHasher } from '../../src/otp/code.js';
import { KeyedHasher } from '../../src/otp/keyed-hash.js';
import type { OtpSender } from '../../src/otp/otp-sender.js';
import { IDENTITY_KEY_PURPOSE, OtpService } from '../../src/otp/otp.service.js';
import type { HitResult, RateLimitStore } from '../../src/otp/rate-limiter.js';

/** A clock tests can move forward. */
export class FakeClock {
  #ms = Date.parse('2026-11-20T10:00:00.000Z');

  now = (): Date => new Date(this.#ms);
  ms = (): number => this.#ms;
  advance(seconds: number): void {
    this.#ms += seconds * 1000;
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  readonly entries = new Map<string, { count: number; expiresAt: number }>();
  readonly #clock: FakeClock;

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  #live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.#clock.ms()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  hit(key: string, windowSeconds: number): Promise<HitResult> {
    const entry = this.#live(key) ?? {
      count: 0,
      expiresAt: this.#clock.ms() + windowSeconds * 1000,
    };
    entry.count += 1;
    this.entries.set(key, entry);
    return Promise.resolve({
      count: entry.count,
      resetSeconds: Math.ceil((entry.expiresAt - this.#clock.ms()) / 1000),
    });
  }

  ttl(key: string): Promise<number> {
    const entry = this.#live(key);
    return Promise.resolve(entry ? Math.ceil((entry.expiresAt - this.#clock.ms()) / 1000) : 0);
  }

  set(key: string, seconds: number): Promise<void> {
    this.entries.set(key, { count: 1, expiresAt: this.#clock.ms() + seconds * 1000 });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

export class InMemoryChallengeStore implements ChallengeStore {
  readonly rows = new Map<string, StoredChallenge & { consumedAt?: Date }>();

  insert(challenge: NewChallenge): Promise<void> {
    this.rows.set(challenge.id, { ...challenge, attempts: 0 });
    return Promise.resolve();
  }

  #open(id: string, now: Date) {
    const row = this.rows.get(id);
    return row && row.consumedAt === undefined && row.expiresAt > now ? row : undefined;
  }

  findOpen(id: string, now: Date): Promise<StoredChallenge | undefined> {
    const row = this.#open(id, now);
    return Promise.resolve(row && { ...row });
  }

  recordAttempt(id: string, max: number, now: Date): Promise<StoredChallenge | undefined> {
    const row = this.#open(id, now);
    if (!row || row.attempts >= max) return Promise.resolve(undefined);
    row.attempts += 1;
    return Promise.resolve({ ...row });
  }

  consume(id: string, now: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.consumedAt !== undefined) return Promise.resolve(false);
    row.consumedAt = now;
    return Promise.resolve(true);
  }
}

export class RecordingOtpSender implements OtpSender {
  readonly sent: { phone: string; code: string }[] = [];
  fail = false;

  send(phone: string, code: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error('provider down'));
    this.sent.push({ phone, code });
    return Promise.resolve();
  }

  lastCode(): string {
    const last = this.sent.at(-1);
    if (!last) throw new Error('no code sent');
    return last.code;
  }
}

export interface OtpHarness {
  service: OtpService;
  clock: FakeClock;
  limits: InMemoryRateLimitStore;
  challenges: InMemoryChallengeStore;
  sender: RecordingOtpSender;
  keyring: SubjectKeyring;
  logger: Logger;
}

export function createOtpHarness(options: { logger?: Logger } = {}): OtpHarness {
  const clock = new FakeClock();
  const limits = new InMemoryRateLimitStore(clock);
  const challenges = new InMemoryChallengeStore();
  const sender = new RecordingOtpSender();
  const keyring = new SubjectKeyring({
    wrapper: new InMemoryKeyWrapper(),
    store: new InMemoryWrappedKeyStore(),
    purpose: IDENTITY_KEY_PURPOSE,
    cacheTtlMs: 0,
  });
  const logger =
    options.logger ??
    createLogger({
      service: 'identity-test',
      level: 'trace',
      destination: { write: () => undefined },
    });
  const service = new OtpService({
    challenges,
    limits,
    sender,
    keyring,
    lookupHasher: new KeyedHasher(randomBytes(32)),
    codeHasher: new CodeHasher(randomBytes(32)),
    logger,
    now: clock.now,
  });
  return { service, clock, limits, challenges, sender, keyring, logger };
}

/** Synthetic South African mobile numbers (rule 6). The 082 000 range is not assigned to anyone real here. */
export const syntheticPhone = (n = 1): string => `+2782000${String(n).padStart(4, '0')}`;

export const client = (n = 1) => ({ deviceId: `device-${String(n)}`, ip: `192.0.2.${String(n)}` });
