import { randomUUID } from 'node:crypto';
import { ConditionStatus } from '@chronos/contracts/disclosure';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { runMigrations } from '@chronos/vault-db';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { startService, type WireProfile } from './support/service.js';

/**
 * Health data must never reach a log line or a gRPC error, on success or failure (CLAUDE.md
 * rule 3). Synthetic markers are planted as own words, notes and condition codes; the harness
 * fails the test if any sink sees them.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
});

afterAll(async () => {
  await db.stop();
});

const LIVING_WITH = ConditionStatus.CONDITION_STATUS_LIVING_WITH;

describe('health profile privacy', () => {
  const privacy = usePrivacyHarness();

  it('never logs or echoes what members save, on success or failure', async () => {
    const { client, stop } = await startService(db.url, privacy.logs.destination);
    const accountId = randomUUID();
    const words = privacy.markers.healthText();
    const note = privacy.markers.healthText();
    const unknownCode = privacy.markers.conditionCode();

    const attempt = async (profile: WireProfile, expectedVersion = 0) => {
      try {
        await call(client.upsertHealthProfile({ accountId, profile, expectedVersion }));
      } catch (error) {
        privacy.grpc.recordError(error);
      }
    };
    try {
      await attempt({
        conditions: [{ code: 'other', status: LIVING_WITH }],
        freeText: words,
        note,
      });
      await call(client.getOwnHealthProfile({ accountId }));
      // Failures: unknown code, over-long text, a stale version, and an undecryptable row.
      await attempt({ conditions: [{ code: unknownCode, status: LIVING_WITH }], freeText: words });
      await attempt({ conditions: [], freeText: `${words} ${'x'.repeat(600)}` });
      await attempt({ conditions: [], note }, 7);
      await db.pool.query(
        `update vault.health_profiles set payload_nonce = decode('00', 'hex')
          where vault_id = (select vault_id from vault.subject_map where account_id = $1)`,
        [accountId],
      );
      await call(client.getOwnHealthProfile({ accountId })).catch((error: unknown) => {
        privacy.grpc.recordError(error);
      });
    } finally {
      await stop();
    }

    expect(privacy.logs.texts().length).toBeGreaterThan(0);
    expect(privacy.grpc.texts()).toHaveLength(4);
    // The harness checks the markers; these are what a reader could link to a person.
    for (const line of [...privacy.logs.texts(), ...privacy.grpc.texts()]) {
      expect(line).not.toContain(accountId);
      expect(line).not.toMatch(/living_with|"other"/);
    }
  });
});
