import { randomUUID } from 'node:crypto';
import { ConditionStatus, GrantScope, Purpose, Visibility } from '@chronos/contracts/disclosure';
import { runMigrations } from '@chronos/vault-db';
import { status } from '@grpc/grpc-js';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/health/health-profile.service.js';
import { LEASE_MS } from '../src/access/view.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import {
  FakeMembers,
  FakeRelationships,
  grpcError,
  startService,
  type DisclosureClient,
} from './support/service.js';

let db: TestDatabase;
/** Wired to fake identity and matching, so every branch can be reached over gRPC. */
let client: DisclosureClient;
/** The real default: matching does not exist yet (M3.1), so others are always denied. */
let defaultClient: DisclosureClient;
const stops: (() => Promise<void>)[] = [];
const members = new FakeMembers();
const relationships = new FakeRelationships();

const LIVING_WITH = ConditionStatus.CONDITION_STATUS_LIVING_WITH;
const PROFILE_VIEW = Purpose.PURPOSE_PROFILE_VIEW;
const DENIED = { allowed: false };

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  const faked = await startService(db.url, undefined, { members, relationships });
  const real = await startService(db.url, undefined, { members });
  client = faked.client;
  defaultClient = real.client;
  stops.push(faked.stop, real.stop);
});

afterAll(async () => {
  for (const stop of stops) await stop();
  await db.stop();
});

/** A member with a saved profile, the given setting, active and verified. */
async function member(visibility: Visibility = Visibility.VISIBILITY_HIDDEN): Promise<string> {
  const id = randomUUID();
  members.verified.set(id, true);
  await call(
    client.upsertHealthProfile({
      accountId: id,
      profile: {
        conditions: [{ code: 'epilepsy', status: LIVING_WITH }],
        freeText: 'Synthetic own words',
        note: 'Synthetic note',
      },
    }),
  );
  if (visibility !== Visibility.VISIBILITY_HIDDEN) {
    await call(client.setVisibility({ accountId: id, visibility }));
  }
  return id;
}

const viewer = (verified = true): string => {
  const id = randomUUID();
  members.verified.set(id, verified);
  return id;
};

const view = (viewerAccountId: string, subjectAccountId: string, c = client) =>
  call(c.viewHealthProfile({ viewerAccountId, subjectAccountId, purpose: PROFILE_VIEW }));

/** The access-log reasons recorded for views of this subject, oldest first. */
async function reasons(subjectAccountId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ reason: string; decision: string }>(
    `select l.decision || ':' || l.reason as reason from vault.health_access_log l
       join vault.subject_map m using (vault_id)
      where m.account_id = $1 and l.reason not in ('self_update') order by l.id`,
    [subjectAccountId],
  );
  return rows.map((r) => r.reason);
}

async function grant(subject: string, viewerId: string, scope: 'full' | 'conditions_only') {
  await db.pool.query(
    `insert into vault.disclosure_grants (vault_id, viewer_account_id, scope)
     select vault_id, $2, $3 from vault.subject_map where account_id = $1`,
    [subject, viewerId, scope],
  );
}

describe('until matching exists (M3.1)', () => {
  it('denies every view by another member, and records why', async () => {
    const subject = await member(Visibility.VISIBILITY_PROFILE);
    expect(await view(viewer(), subject, defaultClient)).toEqual(DENIED);
    expect(await reasons(subject)).toEqual(['deny:relationship_unavailable']);
  });

  it('still lets members see their own, in full, with a lease', async () => {
    const subject = await member();
    const before = Date.now();
    const result = await view(subject, subject, defaultClient);
    expect(result.allowed).toBe(true);
    expect(result.profile).toMatchObject({
      freeText: 'Synthetic own words',
      note: 'Synthetic note',
      scope: GrantScope.GRANT_SCOPE_FULL,
    });
    const lease = result.profile?.leaseExpiresAt as Date | { seconds: string | number } | undefined;
    const leaseMs = lease instanceof Date ? lease.getTime() : Number(lease?.seconds) * 1000;
    expect(leaseMs).toBeGreaterThanOrEqual(Math.floor((before + LEASE_MS) / 1000) * 1000);
    expect(leaseMs).toBeLessThanOrEqual(Date.now() + LEASE_MS);
    expect(await reasons(subject)).toEqual(['allow:self']);
  });
});

describe('each setting', () => {
  it('hidden: nobody else', async () => {
    const subject = await member();
    expect(await view(viewer(), subject)).toEqual(DENIED);
    expect(await reasons(subject)).toEqual(['deny:hidden']);
  });

  it('everyone: verified viewers see conditions only', async () => {
    const subject = await member(Visibility.VISIBILITY_PROFILE);
    const result = await view(viewer(), subject);
    expect(result.allowed).toBe(true);
    expect(result.profile).toMatchObject({
      conditions: [{ code: 'epilepsy', status: LIVING_WITH }],
      freeText: '',
      note: '',
      scope: GrantScope.GRANT_SCOPE_CONDITIONS_ONLY,
    });
    expect(await view(viewer(false), subject)).toEqual(DENIED);
    expect(await reasons(subject)).toEqual(['allow:verified', 'deny:not_verified']);
  });

  it('matches only: an active match sees conditions only', async () => {
    const subject = await member(Visibility.VISIBILITY_MATCH_ONLY);
    const matched = viewer();
    relationships.matches.add(FakeRelationships.key(matched, subject));
    const result = await view(matched, subject);
    expect(result.profile).toMatchObject({
      freeText: '',
      scope: GrantScope.GRANT_SCOPE_CONDITIONS_ONLY,
    });
    expect(await view(viewer(), subject)).toEqual(DENIED);
    expect(await reasons(subject)).toEqual(['allow:match', 'deny:no_match']);
  });

  it('one at a time: only a live grant, with its scope', async () => {
    const subject = await member(Visibility.VISIBILITY_CHAT_GRANT);
    const full = viewer();
    const partial = viewer();
    await grant(subject, full, 'full');
    await grant(subject, partial, 'conditions_only');
    expect((await view(full, subject)).profile).toMatchObject({
      freeText: 'Synthetic own words',
      note: 'Synthetic note',
      scope: GrantScope.GRANT_SCOPE_FULL,
    });
    expect((await view(partial, subject)).profile).toMatchObject({
      freeText: '',
      note: '',
      scope: GrantScope.GRANT_SCOPE_CONDITIONS_ONLY,
    });
    await db.pool.query(
      'update vault.disclosure_grants set revoked_at = now() where viewer_account_id = $1',
      [full],
    );
    expect(await view(full, subject)).toEqual(DENIED);
    expect(await view(viewer(), subject)).toEqual(DENIED);
    expect(await reasons(subject)).toEqual([
      'allow:grant',
      'allow:grant',
      'deny:no_grant',
      'deny:no_grant',
    ]);
  });
});

describe('denials before the setting', () => {
  it('blocked either way, inactive subject, identity down', async () => {
    const subject = await member(Visibility.VISIBILITY_PROFILE);
    const blocked = viewer();
    relationships.blocks.add(FakeRelationships.key(subject, blocked));
    expect(await view(blocked, subject)).toEqual(DENIED);

    members.down = true;
    try {
      expect(await view(viewer(), subject)).toEqual(DENIED);
    } finally {
      members.down = false;
    }

    members.verified.delete(subject); // no longer an active account
    expect(await view(viewer(), subject)).toEqual(DENIED);
    expect(await reasons(subject)).toEqual([
      'deny:blocked',
      'deny:identity_unavailable',
      'deny:inactive',
    ]);
  });

  it('moderation: needs a staff id, and is denied until M5', async () => {
    const subject = await member(Visibility.VISIBILITY_PROFILE);
    const request = {
      viewerAccountId: viewer(),
      subjectAccountId: subject,
      purpose: Purpose.PURPOSE_MODERATION,
    };
    expect((await grpcError(call(client.viewHealthProfile(request)))).code).toBe(
      status.INVALID_ARGUMENT,
    );
    const staffId = randomUUID();
    expect(
      await call(client.viewHealthProfile({ ...request, moderation: { reportId: 'r', staffId } })),
    ).toEqual(DENIED);
    const { rows } = await db.pool.query<{ accessor: string; reason: string }>(
      `select accessor, reason from vault.health_access_log l join vault.subject_map m using (vault_id)
        where m.account_id = $1 and purpose = 'moderation'`,
      [subject],
    );
    expect(rows).toEqual([{ accessor: `staff:${staffId}`, reason: 'moderation_unavailable' }]);
  });
});

describe('no oracle', () => {
  it('answers "no profile" exactly like "hidden"', async () => {
    const hidden = await member();
    const nobody = randomUUID();
    expect(await view(viewer(), nobody)).toEqual(await view(viewer(), hidden));
    // Nothing is in the vault for someone without a profile, so nothing is recorded or created.
    const { rows } = await db.pool.query('select 1 from vault.subject_map where account_id = $1', [
      nobody,
    ]);
    expect(rows).toEqual([]);
  });

  it('rejects an unspecified purpose and bad ids', async () => {
    const subject = await member();
    expect(
      (
        await grpcError(
          call(client.viewHealthProfile({ viewerAccountId: viewer(), subjectAccountId: subject })),
        )
      ).code,
    ).toBe(status.INVALID_ARGUMENT);
    expect((await grpcError(view('not-a-uuid', subject))).code).toBe(status.INVALID_ARGUMENT);
  });
});

describe('SetVisibility', () => {
  it('needs a profile, changes the setting and bumps the version', async () => {
    const accountId = randomUUID();
    expect(
      await grpcError(
        call(client.setVisibility({ accountId, visibility: Visibility.VISIBILITY_PROFILE })),
      ),
    ).toEqual({ code: status.FAILED_PRECONDITION, details: NO_PROFILE });

    await call(client.upsertHealthProfile({ accountId, profile: { conditions: [] } }));
    expect(
      await call(
        client.setVisibility({
          accountId,
          visibility: Visibility.VISIBILITY_MATCH_ONLY,
          filterOptIn: true,
        }),
      ),
    ).toEqual({ visibility: Visibility.VISIBILITY_MATCH_ONLY, filterOptIn: true });
    const own = await call(client.getOwnHealthProfile({ accountId }));
    expect(own.profile).toMatchObject({
      visibility: Visibility.VISIBILITY_MATCH_ONLY,
      filterOptIn: true,
      version: 2,
    });
    expect((await grpcError(call(client.setVisibility({ accountId })))).code).toBe(
      status.INVALID_ARGUMENT,
    );
  });
});
