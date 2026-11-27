/**
 * M3.4: a filtered feed opens every opted-in candidate's profile, and with keys cached for at most
 * 60 s (spec 4.4) a cold call unwraps each one with KMS. With 10 ms a KMS call, 500 candidates of
 * whom 150 opted in must still answer well inside the feed's 300 ms budget.
 */
import { randomUUID } from 'node:crypto';
import { ConditionStatus, FilterOutcome, Visibility } from '@chronos/contracts/disclosure';
import { runMigrations } from '@chronos/vault-db';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { slowUnwraps, startService, type DisclosureClient } from './support/service.js';

const KMS_MS = 10;
let db: TestDatabase;
let fast: { client: DisclosureClient; stop: () => Promise<void> };
let slow: { client: DisclosureClient; stop: () => Promise<void> };

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  fast = await startService(db.url);
  slow = await startService(db.url, undefined, {}, undefined, slowUnwraps(KMS_MS));
}, 120_000);

afterAll(async () => {
  await fast.stop();
  await slow.stop();
  await db.stop();
});

async function member(code: string, filterOptIn: boolean): Promise<string> {
  const accountId = randomUUID();
  const { client } = fast;
  await call(
    client.upsertHealthProfile({
      accountId,
      profile: { conditions: [{ code, status: ConditionStatus.CONDITION_STATUS_LIVING_WITH }] },
    }),
  );
  await call(
    client.setVisibility({ accountId, visibility: Visibility.VISIBILITY_PROFILE, filterOptIn }),
  );
  return accountId;
}

describe('filter speed with KMS-like key unwraps (M3.4)', () => {
  it('opens 150 opted-in candidates of 500 in well under 300 ms', async () => {
    const viewer = await member('asthma', true);
    await call(
      fast.client.setFilterPreferences({ accountId: viewer, wantedConditionCodes: ['t1d'] }),
    );
    const optedIn = [];
    for (let i = 0; i < 150; i += 1)
      optedIn.push(await member(i % 2 === 0 ? 't1d' : 'lupus', true));
    const others = [];
    for (let i = 0; i < 100; i += 1) others.push(await member('t1d', false));
    const unknown = Array.from({ length: 250 }, () => randomUUID());
    const candidates = [...optedIn, ...others, ...unknown];

    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      const result = await call(
        slow.client.filterEligibleSubjects({
          viewerAccountId: viewer,
          candidateAccountIds: candidates,
        }),
      );
      timings.push(performance.now() - started);
      expect(result.outcome).toBe(FilterOutcome.FILTER_OUTCOME_OK);
      expect(result.eligibleAccountIds).toHaveLength(75);
    }
    process.stdout.write(
      `filter of 500 (150 opened, ${String(KMS_MS)} ms per unwrap): ${timings.map((t) => `${String(Math.round(t))} ms`).join(', ')}\n`,
    );
    // One at a time this would be 150 x 10 ms = 1.5 s at the least.
    expect(Math.max(...timings)).toBeLessThan(250);
  }, 120_000);
});
