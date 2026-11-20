import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { CodeHasher, generateCode } from '../src/otp/code.js';
import { OTP_LIMITS } from '../src/otp/limits.js';
import { otpMessage } from '../src/otp/otp-sender.js';
import { OtpRateLimitedError, PHONE_FIELD } from '../src/otp/otp.service.js';
import { parseSouthAfricanMobile, phoneHint } from '../src/otp/phone.js';
import { client, createOtpHarness, syntheticPhone } from './support/otp-fakes.js';

const wrongCode = (right: string): string => (right === '000000' ? '000001' : '000000');

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('South African mobile numbers only (ADR-0018)', () => {
  it.each([
    ['+27820001234', '+27820001234'],
    ['0820001234', '+27820001234'],
    ['27820001234', '+27820001234'],
    ['0027 82 000 1234', '+27820001234'],
    ['082-000-1234', '+27820001234'],
    ['(082) 000 1234', '+27820001234'],
    ['+27610001234', '+27610001234'],
    ['+27710001234', '+27710001234'],
  ])('accepts %s as %s', (input, e164) => {
    expect(parseSouthAfricanMobile(input)).toBe(e164);
  });

  it.each([
    '+26771234567', // Botswana: SADC comes later
    '+447700900123',
    '+27110001234', // landline
    '+2782000123', // too short
    '+278200012345', // too long
    '820001234',
    '',
    'not a number',
    `+27${'8'.repeat(40)}`,
  ])('rejects %s', (input) => {
    expect(parseSouthAfricanMobile(input)).toBeUndefined();
  });

  it('shows at most the last two digits in a hint', () => {
    expect(phoneHint('+27820001234')).toBe('••34');
  });
});

describe('codes', () => {
  it('are six digits, zero-padded', () => {
    for (let i = 0; i < 2000; i += 1) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it('are stored as a keyed hash bound to the challenge', () => {
    const hasher = new CodeHasher(randomBytes(32));
    const a = randomUUID();
    const b = randomUUID();
    expect(hasher.hash(a, '123456')).not.toEqual(hasher.hash(b, '123456'));
    expect(hasher.matches(a, '123456', hasher.hash(a, '123456'))).toBe(true);
    expect(hasher.matches(a, '123457', hasher.hash(a, '123456'))).toBe(false);
    expect(new CodeHasher(randomBytes(32)).matches(a, '123456', hasher.hash(a, '123456'))).toBe(
      false,
    );
  });

  it('use a fixed message that never names the app (ADR-0006)', () => {
    expect(otpMessage('123456')).toBe('Your code is 123456');
  });
});

describe('requestOtp', () => {
  it('sends a code and stores only its hash and the sealed number', async () => {
    const h = createOtpHarness();
    const challenge = await h.service.requestOtp('082 000 0001', client());
    expect(challenge.retryAfterSeconds).toBe(OTP_LIMITS.resendCooldownSeconds);
    expect(challenge.expiresAt.getTime() - h.clock.ms()).toBe(OTP_LIMITS.codeTtlSeconds * 1000);
    expect(h.sender.sent).toEqual([{ phone: syntheticPhone(1), code: h.sender.lastCode() }]);

    const row = h.challenges.rows.get(challenge.challengeId);
    if (!row) throw new Error('challenge not stored');
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(h.sender.lastCode());
    expect(Buffer.concat([row.phoneCiphertext, row.phoneLookup]).toString('latin1')).not.toContain(
      '820000001',
    );
    await expect(
      h.keyring.decrypt(row.prospectiveAccountId, PHONE_FIELD, {
        ciphertext: row.phoneCiphertext,
        nonce: row.phoneNonce,
      }),
    ).resolves.toBe(syntheticPhone(1));
  });

  it('rejects numbers outside South Africa without sending anything', async () => {
    const h = createOtpHarness();
    const error = await rejection(h.service.requestOtp('+26771234567', client()));
    expect(error.code).toBe('invalid_argument');
    expect(h.sender.sent).toHaveLength(0);
  });

  it('makes the member wait 60 seconds between codes', async () => {
    const h = createOtpHarness();
    await h.service.requestOtp(syntheticPhone(), client());
    const error = await rejection(h.service.requestOtp(syntheticPhone(), client()));
    expect(error).toBeInstanceOf(OtpRateLimitedError);
    expect((error as OtpRateLimitedError).retryAfterSeconds).toBe(60);
    h.clock.advance(60);
    await expect(h.service.requestOtp(syntheticPhone(), client())).resolves.toBeDefined();
  });

  it('allows 3 codes per number per 15 minutes', async () => {
    const h = createOtpHarness();
    for (let i = 1; i <= 3; i += 1) {
      await h.service.requestOtp(syntheticPhone(), client(i));
      h.clock.advance(61);
    }
    const error = await rejection(h.service.requestOtp(syntheticPhone(), client(9)));
    expect(error.code).toBe('resource_exhausted');
    expect(h.sender.sent).toHaveLength(3);
    h.clock.advance(15 * 60);
    await expect(h.service.requestOtp(syntheticPhone(), client(9))).resolves.toBeDefined();
  });

  it('allows 10 codes per number per day', async () => {
    const h = createOtpHarness();
    for (let i = 1; i <= 10; i += 1) {
      await h.service.requestOtp(syntheticPhone(), client(i));
      h.clock.advance(15 * 60);
    }
    expect((await rejection(h.service.requestOtp(syntheticPhone(), client(20)))).code).toBe(
      'resource_exhausted',
    );
  });

  it('allows 20 codes per IP per hour across numbers', async () => {
    const h = createOtpHarness();
    const sameIp = (n: number) => ({ deviceId: `device-${String(n)}`, ip: '192.0.2.200' });
    for (let i = 1; i <= 20; i += 1) await h.service.requestOtp(syntheticPhone(i), sameIp(i));
    expect((await rejection(h.service.requestOtp(syntheticPhone(21), sameIp(21)))).code).toBe(
      'resource_exhausted',
    );
  });

  it('allows 10 codes per device per hour across numbers', async () => {
    const h = createOtpHarness();
    const sameDevice = (n: number) => ({ deviceId: 'device-shared', ip: `192.0.2.${String(n)}` });
    for (let i = 1; i <= 10; i += 1) await h.service.requestOtp(syntheticPhone(i), sameDevice(i));
    expect((await rejection(h.service.requestOtp(syntheticPhone(11), sameDevice(11)))).code).toBe(
      'resource_exhausted',
    );
  });

  it('never puts a number, IP or device id in a rate-limit key', async () => {
    const h = createOtpHarness();
    await h.service.requestOtp(syntheticPhone(), client());
    for (const key of h.limits.entries.keys()) {
      expect(key).not.toMatch(/820000001|192\.0\.2|device-1/);
      expect(key).toMatch(/^[a-z]+:[0-9a-f]{64}(:[a-z0-9-]+)?$/);
    }
  });

  it('reports a delivery failure without the provider error', async () => {
    const h = createOtpHarness();
    h.sender.fail = true;
    const error = await rejection(h.service.requestOtp(syntheticPhone(), client()));
    expect(error.code).toBe('unavailable');
    expect(error.message).not.toMatch(/provider/);
  });
});

describe('verifyOtp', () => {
  it('accepts the right code once', async () => {
    const h = createOtpHarness();
    const { challengeId } = await h.service.requestOtp(syntheticPhone(), client());
    const code = h.sender.lastCode();
    const verified = await h.service.verifyOtp(challengeId, code);
    expect(verified.prospectiveAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await rejection(h.service.verifyOtp(challengeId, code))).code).toBe('unauthenticated');
  });

  it('blocks brute force: a code dies after 5 wrong tries, even with the right code next', async () => {
    const h = createOtpHarness();
    const { challengeId } = await h.service.requestOtp(syntheticPhone(), client());
    const code = h.sender.lastCode();
    for (let i = 0; i < OTP_LIMITS.attemptsPerCode; i += 1) {
      expect((await rejection(h.service.verifyOtp(challengeId, wrongCode(code)))).code).toBe(
        'unauthenticated',
      );
    }
    expect((await rejection(h.service.verifyOtp(challengeId, code))).code).toBe('unauthenticated');
  });

  it('counts tries before comparing, so parallel guesses cannot exceed the limit', async () => {
    const h = createOtpHarness();
    const { challengeId } = await h.service.requestOtp(syntheticPhone(), client());
    const code = h.sender.lastCode();
    const guesses = Array.from({ length: 50 }, () =>
      h.service.verifyOtp(challengeId, wrongCode(code)).catch(() => undefined),
    );
    await Promise.all(guesses);
    expect(h.challenges.rows.get(challengeId)?.attempts).toBe(OTP_LIMITS.attemptsPerCode);
  });

  it('locks the number for an hour after 10 failed tries across codes', async () => {
    const h = createOtpHarness();
    for (let round = 0; round < 2; round += 1) {
      const { challengeId } = await h.service.requestOtp(syntheticPhone(), client(round));
      const code = h.sender.lastCode();
      for (let i = 0; i < 5; i += 1)
        await rejection(h.service.verifyOtp(challengeId, wrongCode(code)));
      h.clock.advance(61);
    }
    const locked = await rejection(h.service.requestOtp(syntheticPhone(), client(5)));
    expect(locked.code).toBe('resource_exhausted');
    h.clock.advance(OTP_LIMITS.lockout.lockSeconds);
    await expect(h.service.requestOtp(syntheticPhone(), client(5))).resolves.toBeDefined();
  });

  it('refuses a correct code while the number is locked', async () => {
    const h = createOtpHarness();
    const first = await h.service.requestOtp(syntheticPhone(), client(1));
    for (let i = 0; i < 5; i += 1)
      await rejection(h.service.verifyOtp(first.challengeId, wrongCode(h.sender.lastCode())));
    h.clock.advance(61);
    const second = await h.service.requestOtp(syntheticPhone(), client(2));
    const code = h.sender.lastCode();
    for (let i = 0; i < 4; i += 1)
      await rejection(h.service.verifyOtp(second.challengeId, wrongCode(code)));
    expect((await rejection(h.service.verifyOtp(second.challengeId, wrongCode(code)))).code).toBe(
      'unauthenticated',
    );
    expect((await rejection(h.service.verifyOtp(second.challengeId, code))).code).toBe(
      'resource_exhausted',
    );
  });

  it('rejects an expired code', async () => {
    const h = createOtpHarness();
    const { challengeId } = await h.service.requestOtp(syntheticPhone(), client());
    h.clock.advance(OTP_LIMITS.codeTtlSeconds);
    expect((await rejection(h.service.verifyOtp(challengeId, h.sender.lastCode()))).code).toBe(
      'unauthenticated',
    );
  });

  it('gives the same answer for unknown, malformed, wrong and used codes', async () => {
    const h = createOtpHarness();
    const { challengeId } = await h.service.requestOtp(syntheticPhone(), client());
    const code = h.sender.lastCode();
    const messages = new Set<string>();
    for (const attempt of [
      h.service.verifyOtp(randomUUID(), code),
      h.service.verifyOtp('not-a-uuid', code),
      h.service.verifyOtp(challengeId, '12ab56'),
      h.service.verifyOtp(challengeId, wrongCode(code)),
    ])
      messages.add((await rejection(attempt)).message);
    await h.service.verifyOtp(challengeId, code);
    messages.add((await rejection(h.service.verifyOtp(challengeId, code))).message);
    expect([...messages]).toEqual(['Code not accepted.']);
  });

  it('clears the failure count after a successful sign-in', async () => {
    const h = createOtpHarness();
    const { challengeId } = await h.service.requestOtp(syntheticPhone(), client());
    const code = h.sender.lastCode();
    for (let i = 0; i < 4; i += 1)
      await rejection(h.service.verifyOtp(challengeId, wrongCode(code)));
    await h.service.verifyOtp(challengeId, code);
    expect([...h.limits.entries.keys()].some((k) => k.startsWith('fail:'))).toBe(false);
  });
});
