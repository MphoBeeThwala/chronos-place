import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from '../src/index.js';

describe('constantTimeEqual', () => {
  it('compares equal and unequal values', () => {
    expect(constantTimeEqual('token-a', 'token-a')).toBe(true);
    expect(constantTimeEqual('token-a', 'token-b')).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
  });

  it('handles different lengths and empty values without throwing', () => {
    expect(constantTimeEqual('short', 'much longer value')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});
