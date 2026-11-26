import { randomUUID } from 'node:crypto';
import { ConditionStatus, GrantScope, Purpose, Visibility } from '@chronos/contracts/disclosure';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { runMigrations } from '@chronos/vault-db';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import {
  FakeMembers,
  FakeRelationships,
  startService,
  type WireProfile,
} from './support/service.js';

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
    const members = new FakeMembers();
    const relationships = new FakeRelationships();
    const { client, stop } = await startService(db.url, privacy.logs.destination, {
      members,
      relationships,
    });
    const accountId = randomUUID();
    members.verified.set(accountId, true);
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
      // Views: allowed (self) and denied (another member), plus the setting change.
      await call(client.setVisibility({ accountId, visibility: Visibility.VISIBILITY_PROFILE }));
      const purpose = Purpose.PURPOSE_PROFILE_VIEW;
      await call(
        client.viewHealthProfile({
          viewerAccountId: accountId,
          subjectAccountId: accountId,
          purpose,
        }),
      );
      const denied = await call(
        client.viewHealthProfile({
          viewerAccountId: randomUUID(),
          subjectAccountId: accountId,
          purpose,
        }),
      );
      // A denial says nothing at all: not why, not the setting, nothing from the profile.
      expect(denied).toEqual({ allowed: false });
      // Sharing: a refused share (no match), a share, a view by the match, revoke, the list.
      const match = randomUUID();
      members.verified.set(match, true);
      const pair = { subjectAccountId: accountId, viewerAccountId: match };
      await call(client.grantDisclosure({ ...pair, scope: GrantScope.GRANT_SCOPE_FULL })).catch(
        (error: unknown) => {
          privacy.grpc.recordError(error);
        },
      );
      relationships.matches.add(FakeRelationships.key(accountId, match));
      await call(client.grantDisclosure({ ...pair, scope: GrantScope.GRANT_SCOPE_FULL }));
      await call(
        client.viewHealthProfile({ viewerAccountId: match, subjectAccountId: accountId, purpose }),
      );
      await call(client.revokeDisclosure(pair));
      const listed = await call(client.listHealthViewers({ subjectAccountId: accountId }));
      // Filters: preferences in, a filter run, preferences out. Only ids and outcomes come back.
      await call(
        client.setFilterPreferences({ accountId, wantedConditionCodes: ['cystic_fibrosis'] }),
      );
      const filtered = await call(
        client.filterEligibleSubjects({ viewerAccountId: accountId, candidateAccountIds: [match] }),
      );
      expect(Object.keys(filtered).sort()).toEqual(['outcome']);
      await call(client.getFilterPreferences({ accountId }));
      // Who, when, how often, and whether still shared: nothing from the profile.
      expect(Object.keys(listed.viewers?.[0] ?? {}).sort()).toEqual([
        'hasActiveGrant',
        'lastViewedAt',
        'viewCount',
        'viewerAccountId',
      ]);
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
      // Erasure: nothing about the member in its logs or answer.
      expect(
        await call(client.eraseSubject({ subjectAccountId: accountId, requestId: randomUUID() })),
      ).toEqual({ completed: true });
    } finally {
      await stop();
    }

    expect(privacy.logs.texts().length).toBeGreaterThan(0);
    expect(privacy.grpc.texts()).toHaveLength(5);
    // The harness checks the markers; these are what a reader could link to a person.
    for (const line of [...privacy.logs.texts(), ...privacy.grpc.texts()]) {
      expect(line).not.toContain(accountId);
      expect(line).not.toMatch(/living_with|"other"|cystic_fibrosis/);
      // Nor the access decision's reasons: they reveal a member's setting.
      expect(line).not.toMatch(/relationship_unavailable|not_verified|no_grant|"hidden"/);
    }
  });
});
