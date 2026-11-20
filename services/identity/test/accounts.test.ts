import { parseEvent } from '@chronos/contracts/events';
import { KeyDestroyedError } from '@chronos/crypto';
import { DomainError } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/accounts/account.service.js';
import { PHONE_FIELD, type VerifiedPhone } from '../src/otp/otp.service.js';
import { InMemoryAccountStore } from './support/account-fakes.js';
import { client, createOtpHarness, syntheticPhone } from './support/otp-fakes.js';

// 20 November 2026, midday in South Africa.
const NOW = new Date('2026-11-20T10:00:00.000Z');

function setup() {
  const otp = createOtpHarness();
  const accounts = new InMemoryAccountStore();
  const revoked: string[] = [];
  const service = new AccountService({
    accounts,
    keyring: otp.keyring,
    revokeAllSessions: (accountId) => {
      revoked.push(accountId);
      return Promise.resolve();
    },
    logger: otp.logger,
    now: () => NOW,
  });
  const verify = async (n = 1): Promise<VerifiedPhone> => {
    otp.clock.advance(61);
    const { challengeId } = await otp.service.requestOtp(syntheticPhone(n), client(n));
    return otp.service.verifyOtp(challengeId, otp.sender.lastCode());
  };
  return { otp, accounts, service, revoked, verify };
}

const sealedPhone = (v: VerifiedPhone) => ({ ciphertext: v.phoneCiphertext, nonce: v.phoneNonce });

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('sign-in', () => {
  it('creates a pending account under the id the number was sealed with', async () => {
    const { service, verify, otp } = setup();
    const verified = await verify();
    const result = await service.signIn(verified);
    expect(result).toEqual({
      created: true,
      account: {
        id: verified.prospectiveAccountId,
        status: 'pending_onboarding',
        hasDateOfBirth: false,
      },
    });
    await expect(
      otp.keyring.decrypt(result.account.id, PHONE_FIELD, sealedPhone(verified)),
    ).resolves.toBe(syntheticPhone());
  });

  it('signs an existing number into its account and shreds the spare sealed copy', async () => {
    const { service, verify, otp } = setup();
    const first = await service.signIn(await verify());
    const again = await verify();
    const result = await service.signIn(again);
    expect(result).toEqual({ created: false, account: first.account });
    await expect(
      otp.keyring.decrypt(again.prospectiveAccountId, PHONE_FIELD, sealedPhone(again)),
    ).rejects.toBeInstanceOf(KeyDestroyedError);
  });
});

describe('account.created event', () => {
  it('is written with a new account and carries ids and a timestamp only', async () => {
    const { service, verify, accounts } = setup();
    const { account } = await service.signIn(await verify());
    expect(accounts.events).toHaveLength(1);
    const [event] = accounts.events;
    expect(parseEvent('account.created', event)).toEqual(event);
    expect(event?.data).toEqual({ accountId: account.id, createdAt: NOW.toISOString() });
    expect(event?.producer).toBe('identity');
  });

  it('is not written when an existing member signs in again', async () => {
    const { service, verify, accounts } = setup();
    await service.signIn(await verify());
    await service.signIn(await verify());
    expect(accounts.events).toHaveLength(1);
  });
});

describe('date of birth and the 18+ rule', () => {
  it('activates an adult and keeps the date', async () => {
    const { service, verify, accounts } = setup();
    const { account } = await service.signIn(await verify());
    const result = await service.setDateOfBirth(account.id, { year: 2008, month: 11, day: 20 });
    expect(result.status).toBe('active');
    expect(accounts.rows.get(account.id)?.dateOfBirth).toBe('2008-11-20');
  });

  it('blocks someone under 18 for good: ineligible, sessions ended, number unrecoverable, date not kept', async () => {
    const { service, verify, accounts, revoked, otp } = setup();
    const verified = await verify();
    const { account } = await service.signIn(verified);
    const result = await service.setDateOfBirth(account.id, { year: 2008, month: 11, day: 21 });
    expect(result.status).toBe('ineligible');
    expect(revoked).toEqual([account.id]);
    expect(accounts.rows.get(account.id)?.dateOfBirth).toBeNull();
    await expect(
      otp.keyring.decrypt(account.id, PHONE_FIELD, sealedPhone(verified)),
    ).rejects.toBeInstanceOf(KeyDestroyedError);
  });

  it('does not let an ineligible member try another date', async () => {
    const { service, verify } = setup();
    const { account } = await service.signIn(await verify());
    await service.setDateOfBirth(account.id, { year: 2012, month: 1, day: 1 });
    const error = await domainError(
      service.setDateOfBirth(account.id, { year: 1990, month: 1, day: 1 }),
    );
    expect(error.code).toBe('failed_precondition');
  });

  it('does not let the number sign in again after being found under 18', async () => {
    const { service, verify } = setup();
    const { account } = await service.signIn(await verify(3));
    await service.setDateOfBirth(account.id, { year: 2012, month: 1, day: 1 });
    expect((await domainError(service.signIn(await verify(3)))).code).toBe('failed_precondition');
  });

  it('takes the date only once', async () => {
    const { service, verify } = setup();
    const { account } = await service.signIn(await verify());
    await service.setDateOfBirth(account.id, { year: 1990, month: 1, day: 1 });
    expect(
      (await domainError(service.setDateOfBirth(account.id, { year: 1980, month: 1, day: 1 })))
        .code,
    ).toBe('failed_precondition');
  });

  it.each([
    [{ year: 2001, month: 2, day: 29 }, 'a date that does not exist'],
    [{ year: 2026, month: 11, day: 21 }, 'a future date'],
    [{ year: 1899, month: 12, day: 31 }, 'a date before 1900'],
  ])('rejects %o (%s) without changing the account', async (date) => {
    const { service, verify, accounts } = setup();
    const { account } = await service.signIn(await verify());
    expect((await domainError(service.setDateOfBirth(account.id, date))).code).toBe(
      'invalid_argument',
    );
    expect(accounts.rows.get(account.id)?.status).toBe('pending_onboarding');
  });

  it('gives no detail about the account in its errors', async () => {
    const { service } = setup();
    const error = await domainError(
      service.setDateOfBirth('00000000-0000-4000-8000-000000000000', {
        year: 1990,
        month: 1,
        day: 1,
      }),
    );
    expect(error.message).toBe('This account cannot be used.');
  });
});
