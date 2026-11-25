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

describe('location privacy (rule 8)', () => {
  const privacy = usePrivacyHarness();

  it('never logs a coordinate or returns one to another member', async () => {
    const { service, facts } = setup({
      write: (line: string) => {
        privacy.logs.destination.write(line);
      },
    });
    const other = '55555555-5555-4555-8555-000000000002';
    facts.facts.set(other, { age: 33, verified: false });
    await service.update(ACCOUNT, { displayName: 'Viewer', intent: 'dating' });
    await service.update(other, { displayName: 'Other', intent: 'dating' });

    // Six-decimal coordinates, as a browser would send them.
    const latitude = Number(privacy.markers.coordinate());
    const otherLatitude = Number(privacy.markers.coordinate());
    await service.setLocation(ACCOUNT, { latitude, longitude: 28.047349 });
    await service.setLocation(other, { latitude: otherLatitude, longitude: 28.229271 });
    await service.setLocation(ACCOUNT, { latitude: 200, longitude: 0 }).catch(() => undefined);

    const views = await service.publicProfiles(ACCOUNT, [other]);
    privacy.http.record(
      {
        method: 'POST',
        url: '/chronos.profile.v1.ProfileService/GetPublicProfiles',
        status: 200,
        body: JSON.stringify(views),
      },
      { recordRequestUrl: false },
    );
    expect(views[0]?.distanceKm).toBeGreaterThanOrEqual(1);
    expect(privacy.logs.texts().length).toBeGreaterThan(0);
  });
});
