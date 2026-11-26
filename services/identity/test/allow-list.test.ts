import { callersFromProto, callersOf } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { IDENTITY_ALLOW_LIST } from '../src/allow-list.js';
import { IDENTITY_PROTO } from '../src/proto.js';

describe('identity allow-list', () => {
  it('names exactly the callers the contract names, for every method', () => {
    expect(Object.fromEntries(callersOf(IDENTITY_ALLOW_LIST.methods))).toEqual(
      Object.fromEntries(callersFromProto(IDENTITY_PROTO, 'IdentityService')),
    );
  });
});
