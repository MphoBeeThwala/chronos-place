import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, setup } from './support/harness.js';

/**
 * Members write their own bio and prompt answers, and some will mention a condition there
 * (ADR-0023, decision i). That text must never reach a log line, on success or failure
 * (CLAUDE.md rule 3). The harness plants synthetic health text and identity markers and fails the
 * test if any sink sees them.
 */
describe('profile privacy', () => {
  const privacy = usePrivacyHarness();

  it('never logs what members write', async () => {
    const { service } = setup({
      write: (line: string) => {
        privacy.logs.destination.write(line);
      },
    });
    const health = privacy.markers.healthText();
    const email = privacy.markers.email();

    await service.update(ACCOUNT, { displayName: 'Lerato', intent: 'dating', bio: health });
    await service.update(ACCOUNT, {
      prompts: [{ promptId: 'laugh', answer: `${health} ${email}` }],
      pronouns: 'she/her',
    });
    // Failures too: an over-long bio and an unknown prompt.
    await service.update(ACCOUNT, { bio: `${health} ${'x'.repeat(600)}` }).catch(() => undefined);
    await service
      .update(ACCOUNT, { prompts: [{ promptId: health, answer: health }] })
      .catch(() => undefined);
    await service.updatePreferences(ACCOUNT, { genders: [health] });

    expect(privacy.logs.texts().length).toBeGreaterThan(0);
    for (const line of privacy.logs.texts()) expect(line).not.toMatch(/Lerato|she\/her/);
  });
});
