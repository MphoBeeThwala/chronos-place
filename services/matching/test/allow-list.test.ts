import { callersFromProto, callersOf } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { MATCHING_ALLOW_LIST } from '../src/allow-list.js';
import { MATCHING_PROTO } from '../src/proto.js';

describe('matching allow-list', () => {
  it('names exactly the callers the contract names, for every method', () => {
    expect(Object.fromEntries(callersOf(MATCHING_ALLOW_LIST.methods))).toEqual(
      Object.fromEntries(callersFromProto(MATCHING_PROTO, 'MatchingService')),
    );
  });
});
