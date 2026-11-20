import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { describe, expect, it } from 'vitest';
import { client, createOtpHarness } from './support/otp-fakes.js';

/**
 * Phone numbers and codes must never reach logs or error responses (CLAUDE.md rule 3, ADR-0018).
 * The harness plants a synthetic number and fails the test if any form of it shows up in a sink.
 */
describe('OTP privacy', () => {
  const privacy = usePrivacyHarness();

  const setup = () => {
    const logger = createLogger({
      service: 'identity',
      level: 'trace',
      destination: privacy.logs.destination,
    });
    return createOtpHarness({ logger });
  };

  const settle = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      privacy.grpc.recordError(error);
    }
  };

  it('keeps the number and the code out of logs and errors on the happy path', async () => {
    const h = setup();
    const phone = privacy.markers.phone();
    const { challengeId } = await h.service.requestOtp(phone, client());
    const code = h.sender.lastCode();
    await h.service.verifyOtp(challengeId, code);
    for (const line of privacy.logs.texts()) expect(line).not.toContain(code);
  });

  it('keeps them out on every failure path, including lockout and delivery errors', async () => {
    const h = setup();
    const phone = privacy.markers.phone();
    const { challengeId } = await h.service.requestOtp(phone, client());
    const code = h.sender.lastCode();
    const wrong = code === '000000' ? '000001' : '000000';
    await settle(h.service.requestOtp(phone, client())); // cooldown
    for (let i = 0; i < 6; i += 1) await settle(h.service.verifyOtp(challengeId, wrong));
    h.clock.advance(61);
    const second = await h.service.requestOtp(phone, client(2));
    for (let i = 0; i < 5; i += 1) await settle(h.service.verifyOtp(second.challengeId, wrong));
    await settle(h.service.requestOtp(phone, client(3))); // locked
    await settle(h.service.requestOtp(`${phone}99`, client(4))); // invalid number

    h.clock.advance(3600);
    h.sender.fail = true;
    await settle(h.service.requestOtp(phone, client(5)));

    for (const line of privacy.logs.texts()) expect(line).not.toContain(code);
    expect(privacy.logs.texts().some((line) => line.includes('otp lockout applied'))).toBe(true);
  });
});
