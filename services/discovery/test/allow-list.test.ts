import { callersFromProto, callersOf } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_ALLOW_LIST } from '../src/allow-list.js';
import { DISCOVERY_PROTO } from '../src/proto.js';

describe('discovery allow-list', () => {
  it('names exactly the callers the contract names, for every method', () => {
    expect(Object.fromEntries(callersOf(DISCOVERY_ALLOW_LIST.methods))).toEqual(
      Object.fromEntries(callersFromProto(DISCOVERY_PROTO, 'DiscoveryService')),
    );
  });
});
