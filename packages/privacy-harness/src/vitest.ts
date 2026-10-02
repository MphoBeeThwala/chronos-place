import { afterEach, beforeEach } from 'vitest';
import { createPrivacyHarness, type HarnessOptions, type PrivacyHarness } from './harness.js';

/**
 * Call inside a `describe`. Each test gets a fresh harness (use it through the returned object), and
 * the test fails afterwards if any sink saw a marker or an unredacted sensitive field.
 */
export function usePrivacyHarness(options: HarnessOptions = {}): PrivacyHarness {
  let current = createPrivacyHarness(options);
  beforeEach(() => {
    current = createPrivacyHarness(options);
  });
  afterEach(() => {
    current.assertClean();
  });
  return new Proxy({} as PrivacyHarness, {
    get: (_target, property) => (current as unknown as Record<string | symbol, unknown>)[property],
  });
}
