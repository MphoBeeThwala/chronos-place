import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Purpose } from '@chronos/contracts/disclosure';
import { PERMISSION_DENIED_MESSAGE } from '@chronos/service-kit';
import { generatePki, type Pki } from '@chronos/service-kit/pki';
import { runMigrations } from '@chronos/vault-db';
import { status } from '@grpc/grpc-js';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { FakeMembers, grpcError, startService, type DisclosureClient } from './support/service.js';

/** The Disclosure Service's caller allow-list over real mTLS (M2.5 AC). */
let db: TestDatabase;
let dir: string;
let pki: Pki;
let as: (caller: string) => DisclosureClient;
let stop: () => Promise<void>;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  dir = mkdtempSync(path.join(tmpdir(), 'disclosure-pki-'));
  pki = generatePki(dir, ['disclosure-service', 'gateway', 'moderation', 'discovery', 'identity']);
  ({ clientAs: as, stop } = await startService(
    db.url,
    undefined,
    { members: new FakeMembers() },
    pki,
  ));
}, 60_000);

afterAll(async () => {
  await stop();
  await db.stop();
  rmSync(dir, { recursive: true, force: true });
});

const DENIED = { code: status.PERMISSION_DENIED, details: PERMISSION_DENIED_MESSAGE };
const viewRequest = (purpose: Purpose, reportId?: string) => ({
  viewerAccountId: randomUUID(),
  subjectAccountId: randomUUID(),
  purpose,
  ...(reportId === undefined ? {} : { moderation: { reportId, staffId: randomUUID() } }),
});

describe('Disclosure Service allow-list over mTLS', () => {
  it('lets the gateway use the member-facing calls', async () => {
    expect(await call(as('gateway').getOwnHealthProfile({ accountId: randomUUID() }))).toEqual({});
    expect((await call(as('gateway').listConditionTaxonomy({}))).entries).toHaveLength(24);
  });

  it('refuses another service on a member-facing call (M2.5 AC)', async () => {
    for (const caller of ['discovery', 'identity', 'moderation']) {
      expect(
        await grpcError(call(as(caller).getOwnHealthProfile({ accountId: randomUUID() }))),
        caller,
      ).toEqual(DENIED);
    }
  });

  it('never lets the gateway claim the moderation purpose', async () => {
    const gateway = as('gateway');
    expect(
      await grpcError(
        call(gateway.viewHealthProfile(viewRequest(Purpose.PURPOSE_MODERATION, 'r1'))),
      ),
    ).toEqual(DENIED);
    expect(
      await call(gateway.viewHealthProfile(viewRequest(Purpose.PURPOSE_PROFILE_VIEW))),
    ).toEqual({ allowed: false });
  });

  it('lets moderation ask only for moderation, with a report id', async () => {
    const moderation = as('moderation');
    // Passes the allow-list; the access decision still refuses until M5.
    expect(
      await call(moderation.viewHealthProfile(viewRequest(Purpose.PURPOSE_MODERATION, 'r1'))),
    ).toEqual({ allowed: false });
    expect(
      await grpcError(
        call(moderation.viewHealthProfile(viewRequest(Purpose.PURPOSE_MODERATION, ''))),
      ),
    ).toEqual(DENIED);
    expect(
      await grpcError(
        call(moderation.viewHealthProfile(viewRequest(Purpose.PURPOSE_PROFILE_VIEW))),
      ),
    ).toEqual(DENIED);
  });

  it('refuses export: no handler yet, and no caller once there is one', async () => {
    // Unimplemented methods are refused before the guard runs; the rule itself is unit-tested.
    expect((await grpcError(call(as('identity').exportSubject({})))).code).toBe(
      status.UNIMPLEMENTED,
    );
  });
});
