import { callersFromProto, callersOf, isAllowed } from '@chronos/service-kit';
import { describe, expect, it } from 'vitest';
import { DISCLOSURE_ALLOW_LIST } from '../src/allow-list.js';
import { DISCLOSURE_PROTO } from '../src/proto.js';

describe('Disclosure Service allow-list', () => {
  it('names exactly the callers the contract names, for every method', () => {
    expect(Object.fromEntries(callersOf(DISCLOSURE_ALLOW_LIST.methods))).toEqual(
      Object.fromEntries(callersFromProto(DISCLOSURE_PROTO, 'DisclosureService')),
    );
  });

  it('lets nobody call export until ADR-0025 decision g', () => {
    for (const caller of ['identity', 'gateway', 'moderation', 'discovery']) {
      expect(
        isAllowed(
          DISCLOSURE_ALLOW_LIST,
          '/chronos.disclosure.v1.DisclosureService/ExportSubject',
          caller,
          {},
        ),
      ).toBe(false);
    }
  });
});
