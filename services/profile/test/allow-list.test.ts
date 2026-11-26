import { callersFromProto, callersOf } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { PROFILE_ALLOW_LIST } from '../src/allow-list.js';
import { PROFILE_PROTO } from '../src/proto.js';

describe('profile allow-list', () => {
  it('names exactly the callers the contract names, for every method', () => {
    expect(Object.fromEntries(callersOf(PROFILE_ALLOW_LIST.methods))).toEqual(
      Object.fromEntries(callersFromProto(PROFILE_PROTO, 'ProfileService')),
    );
  });
});
