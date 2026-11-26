import { randomUUID } from 'node:crypto';
import { ConditionStatus, GrantScope, Purpose, Visibility } from '@chronos/contracts/disclosure';
import { runMigrations } from '@chronos/vault-db';
import { status } from '@grpc/grpc-js';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHARE_NEEDS_MATCH } from '../src/access/sharing.service.js';
import { NO_PROFILE } from '../src/health/health-profile.service.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import {
  FakeMembers,
  FakeRelationships,
  grpcError,
  startService,
  type DisclosureClient,
} from './support/service.js';

let db: TestDatabase;
let client: DisclosureClient;
/** The real default: matching does not exist yet (M3.1). */
let defaultClient: DisclosureClient;
const stops: (() => Promise<void>)[] = [];
const members = new FakeMembers();
const relationships = new FakeRelationships();

const FULL = GrantScope.GRANT_SCOPE_FULL;
const CONDITIONS_ONLY = GrantScope.GRANT_SCOPE_CONDITIONS_ONLY;

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

/** A member with a saved profile shared "one person at a time". */
async function subject(): Promise<string> {
  const id = randomUUID();
  members.verified.set(id, true);
  await call(
    client.upsertHealthProfile({
      accountId: id,
      profile: {
        conditions: [{ code: 'lupus', status: ConditionStatus.CONDITION_STATUS_LIVING_WITH }],
        freeText: 'Synthetic own words',
      },
    }),
  );
  await call(client.setVisibility({ accountId: id, visibility: Visibility.VISIBILITY_CHAT_GRANT }));
  return id;
}

/** An active, verified member matched with `with`. */
function match(withId: string): string {
  const id = randomUUID();
  members.verified.set(id, true);
  relationships.matches.add(FakeRelationships.key(id, withId));
  return id;
}

const share = (subjectAccountId: string, viewerAccountId: string, scope = FULL, c = client) =>
  call(c.grantDisclosure({ subjectAccountId, viewerAccountId, scope }));
const revoke = (subjectAccountId: string, viewerAccountId: string) =>
  call(client.revokeDisclosure({ subjectAccountId, viewerAccountId }));
const view = (viewerAccountId: string, subjectAccountId: string) =>
  call(
    client.viewHealthProfile({
      viewerAccountId,
      subjectAccountId,
      purpose: Purpose.PURPOSE_PROFILE_VIEW,
    }),
  );
const viewers = (subjectAccountId: string, pageSize?: number, pageToken?: string) =>
  call(
    client.listHealthViewers({
      subjectAccountId,
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(pageToken === undefined ? {} : { pageToken }),
    }),
  );

describe('M2.4 acceptance: revocation blocks the next view immediately', () => {
  it('share, view, revoke, and the very next view is refused', async () => {
    const member = await subject();
    const viewer = match(member);
    const granted = await share(member, viewer);
    expect(granted.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await view(viewer, member)).allowed).toBe(true);

    expect(await revoke(member, viewer)).toEqual({ revoked: true });
    expect(await view(viewer, member)).toEqual({ allowed: false });
    // Revoking again is not an error.
    expect(await revoke(member, viewer)).toEqual({ revoked: false });
  });
});

describe('GrantDisclosure', () => {
  it('changing the scope replaces the share with a new consent', async () => {
    const member = await subject();
    const viewer = match(member);
    const first = await share(member, viewer, FULL);
    const second = await share(member, viewer, CONDITIONS_ONLY);
    expect(second.grantId).not.toBe(first.grantId);
    expect((await view(viewer, member)).profile).toMatchObject({
      freeText: '',
      scope: CONDITIONS_ONLY,
    });
    const { rows } = await db.pool.query<{ scope: string; live: boolean }>(
      `select scope, revoked_at is null as live from vault.disclosure_grants
        where viewer_account_id = $1 order by granted_at, revoked_at nulls last`,
      [viewer],
    );
    expect(rows).toEqual([
      { scope: 'full', live: false },
      { scope: 'conditions_only', live: true },
    ]);
  });

  it('keeps one live share when two are made at once', async () => {
    const member = await subject();
    const viewer = match(member);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => share(member, viewer)),
    );
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as { code: number }).code).toBe(status.ABORTED);
    }
    const { rows } = await db.pool.query(
      `select 1 from vault.disclosure_grants where viewer_account_id = $1 and revoked_at is null`,
      [viewer],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses without a match, when blocked, or with an inactive viewer, the same way', async () => {
    const member = await subject();
    const stranger = randomUUID();
    members.verified.set(stranger, true);
    const blocked = match(member);
    relationships.blocks.add(FakeRelationships.key(member, blocked));
    const gone = match(member);
    members.verified.delete(gone);
    const refusal = { code: status.FAILED_PRECONDITION, details: SHARE_NEEDS_MATCH };
    for (const viewer of [stranger, blocked, gone]) {
      expect(await grpcError(share(member, viewer))).toEqual(refusal);
    }
  });

  it('refuses until matching exists (M3.1)', async () => {
    const member = await subject();
    expect(await grpcError(share(member, match(member), FULL, defaultClient))).toEqual({
      code: status.FAILED_PRECONDITION,
      details: SHARE_NEEDS_MATCH,
    });
  });

  it('needs a saved profile, another member and a scope', async () => {
    const noProfile = randomUUID();
    expect(await grpcError(share(noProfile, match(noProfile)))).toEqual({
      code: status.FAILED_PRECONDITION,
      details: NO_PROFILE,
    });
    const member = await subject();
    expect((await grpcError(share(member, member))).code).toBe(status.INVALID_ARGUMENT);
    expect(
      (await grpcError(share(member, match(member), GrantScope.GRANT_SCOPE_UNSPECIFIED))).code,
    ).toBe(status.INVALID_ARGUMENT);
  });
});

describe('ListHealthViewers', () => {
  it('lists people who saw it, newest first, with counts and live shares; not the member', async () => {
    const member = await subject();
    const early = match(member);
    const late = match(member);
    const refused = match(member);
    await share(member, early);
    await share(member, late);
    await view(early, member);
    await view(early, member);
    await view(late, member);
    await revoke(member, early);
    await view(early, member); // refused: not listed, not counted
    await view(refused, member); // never shared: refused, not listed
    await call(client.getOwnHealthProfile({ accountId: member }));

    const { viewers: listed = [], nextPageToken } = await viewers(member);
    expect(
      listed.map((v) => ({
        viewerAccountId: v.viewerAccountId,
        viewCount: v.viewCount,
        hasActiveGrant: v.hasActiveGrant,
      })),
    ).toEqual([
      { viewerAccountId: late, viewCount: 1, hasActiveGrant: true },
      { viewerAccountId: early, viewCount: 2, hasActiveGrant: false },
    ]);
    expect(nextPageToken).toBe('');

    // Reading the list is itself recorded.
    const { rows } = await db.pool.query(
      `select 1 from vault.health_access_log l join vault.subject_map m using (vault_id)
        where m.account_id = $1 and l.reason = 'self_viewers'`,
      [member],
    );
    expect(rows).toHaveLength(1);
  });

  it('pages without repeating or skipping anyone', async () => {
    const member = await subject();
    const all = Array.from({ length: 5 }, () => match(member));
    for (const viewer of all) {
      await share(member, viewer);
      await view(viewer, member);
    }
    const seen: string[] = [];
    let token = '';
    let pages = 0;
    do {
      const page = await viewers(member, 2, token);
      seen.push(...(page.viewers ?? []).map((v) => v.viewerAccountId));
      token = page.nextPageToken;
      pages += 1;
    } while (token !== '' && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...all].reverse());
  });

  it('is empty for a member with nothing in the vault, and rejects a bad page token', async () => {
    expect(await viewers(randomUUID())).toEqual({ nextPageToken: '' });
    const member = await subject();
    expect((await grpcError(viewers(member, 2, 'not-a-token'))).code).toBe(status.INVALID_ARGUMENT);
  });
});
