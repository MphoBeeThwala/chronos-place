import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, capture, setup } from './support/verification-harness.js';

/**
 * Selfies are biometric information, and the vendor's job id points at them. Neither may reach a
 * log line (CLAUDE.md rule 3, ADR-0022). The whole flow is run with trace logging and every line
 * is scanned.
 */
describe('verification privacy', () => {
  const privacy = usePrivacyHarness();

  it('never logs images or vendor job ids', async () => {
    const h = setup({ logs: privacy.logs.destination });
    const c = capture();
    h.provider.queue({ state: 'pending' }, { state: 'failed', failure: 'poor_quality' });
    await h.service.submit(ACCOUNT, c);
    h.advance(5_000);
    await h.worker.runOnce();
    h.provider.settle('fake-job-1', { state: 'failed', failure: 'poor_quality' });
    h.advance(60_000);
    await h.worker.runOnce();
    h.provider.failSubmit = new Error('vendor down');
    await h.service.submit(ACCOUNT, c);
    await h.service.forget(ACCOUNT);
    await h.worker.runOnce();

    const forbidden = [
      c.selfie.toString('base64').slice(0, 40),
      c.frames[0]?.toString('base64').slice(0, 40) ?? '',
      'SSSSSSSSSS',
      'fake-job',
    ];
    const lines = privacy.logs.texts();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) for (const text of forbidden) expect(line).not.toContain(text);
  });
});
