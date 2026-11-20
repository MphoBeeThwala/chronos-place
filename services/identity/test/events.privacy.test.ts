import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/accounts/account.service.js';
import { InMemoryAccountStore } from './support/account-fakes.js';
import { client, createOtpHarness } from './support/otp-fakes.js';

/** account.created goes to every service; it must carry nothing about the member but the id. */
describe('account events privacy', () => {
  const privacy = usePrivacyHarness();

  it('keeps the phone number out of account.created', async () => {
    const logger = createLogger({ service: 'identity', destination: privacy.logs.destination });
    const otp = createOtpHarness({ logger });
    const accounts = new InMemoryAccountStore();
    const service = new AccountService({
      accounts,
      keyring: otp.keyring,
      revokeAllSessions: () => Promise.resolve(),
      logger,
    });
    const { challengeId } = await otp.service.requestOtp(privacy.markers.phone(), client());
    await service.signIn(await otp.service.verifyOtp(challengeId, otp.sender.lastCode()));

    expect(accounts.events).toHaveLength(1);
    for (const event of accounts.events) privacy.events.publish(event.type, event);
  });
});
