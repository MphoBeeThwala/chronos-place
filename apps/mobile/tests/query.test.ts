import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../src/query/client';

describe('createQueryClient', () => {
  it('keeps data briefly in memory and does not retry mutations', () => {
    const { queries, mutations } = createQueryClient().getDefaultOptions();
    expect(queries?.gcTime).toBeLessThanOrEqual(60_000);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(mutations?.retry).toBe(0);
  });

  it('creates an independent client each time', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});
