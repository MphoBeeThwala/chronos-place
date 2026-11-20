import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as identity from '../gen/chronos/identity/v1/identity.js';
import { AccountStatus, IDENTITY_SERVICE_NAME } from '../gen/chronos/identity/v1/identity.js';

const PROTO = readFileSync(
  new URL('../proto/chronos/identity/v1/identity.proto', import.meta.url),
  'utf8',
);
const SYNTHETIC_PHONE = '+27820000001';
const AT = new Date('2026-11-20T12:00:00.000Z');

type Message = {
  encode: (m: never) => { finish: () => Uint8Array };
  decode: (b: Uint8Array) => unknown;
  fromPartial: (p: object) => never;
};

const messages = (Object.entries(identity) as [string, unknown][]).filter(
  ([, value]) =>
    typeof value === 'object' && value !== null && 'fromPartial' in value && 'encode' in value,
) as unknown as [string, Message][];

/** Field names of every message in the proto, keyed by message name. */
const protoFields = (): Map<string, string[]> => {
  const fields = new Map<string, string[]>();
  for (const match of PROTO.matchAll(/^message (\w+) \{([^}]*)\}/gm)) {
    const [, name = '', body = ''] = match;
    const names = [...body.matchAll(/^\s+(?:repeated )?[\w.]+ (\w+) = \d+;/gm)].map((m) => m[1]);
    fields.set(
      name,
      names.filter((n): n is string => n !== undefined),
    );
  }
  return fields;
};

describe('identity protobuf messages', () => {
  it('generates the service and every message', () => {
    expect(IDENTITY_SERVICE_NAME).toBe('IdentityService');
    expect(messages.map(([name]) => name).sort()).toEqual([...protoFields().keys()].sort());
  });

  it.each(messages)('%s survives an encode/decode round trip (empty)', (_name, message) => {
    const value = message.fromPartial({});
    expect(message.decode(message.encode(value).finish())).toEqual(value);
  });

  it('round-trips a sign-in with tokens and timestamps', () => {
    const response = identity.VerifyOtpResponse.fromPartial({
      account: { accountId: 'acc-1', status: AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING },
      tokens: {
        accessToken: 'synthetic.access.token',
        accessExpiresAt: AT,
        refreshToken: 'synthetic-refresh',
        refreshExpiresAt: AT,
      },
      created: true,
    });
    expect(
      identity.VerifyOtpResponse.decode(identity.VerifyOtpResponse.encode(response).finish()),
    ).toEqual(response);
  });

  it('keeps the unspecified status at zero, so an unset status is never a real state', () => {
    expect(AccountStatus.ACCOUNT_STATUS_UNSPECIFIED).toBe(0);
  });
});

describe('privacy: phone numbers cross the boundary in one direction only (ADR-0018)', () => {
  it('has a phone field only on RequestOtpRequest', () => {
    const withPhone = [...protoFields()]
      .filter(([, names]) => names.some((n) => /phone|msisdn|e164/i.test(n)))
      .map(([name]) => name);
    expect(withPhone).toEqual(['RequestOtpRequest']);
  });

  it('never echoes the client context, the code or the date of birth in a response', () => {
    for (const [name, names] of protoFields()) {
      if (!name.endsWith('Response') && name !== 'Account' && name !== 'SessionTokens') continue;
      for (const field of names) expect(field).not.toMatch(/phone|code|client|ip|device|birth/i);
    }
  });

  it('does not carry a synthetic number into an encoded response', () => {
    const encoded = identity.RequestOtpResponse.encode(
      identity.RequestOtpResponse.fromPartial({ challengeId: 'c-1', retryAfterSeconds: 30 }),
    ).finish();
    expect(Buffer.from(encoded).toString('utf8')).not.toContain(SYNTHETIC_PHONE);
  });
});
