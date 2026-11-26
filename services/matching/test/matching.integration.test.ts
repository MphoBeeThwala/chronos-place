import { randomUUID } from 'node:crypto';
import { status } from '@grpc/grpc-js';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { ordered } from '../src/matching/matching-store.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { grpcError, startService, type MatchingClient } from './support/service.js';

let db: TestDatabase;
let client: MatchingClient;
let stop: () => Promise<void>;
let bus: Awaited<ReturnType<typeof startService>>['bus'];

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  ({ client, stop, bus } = await startService(db.url));
});

afterAll(async () => {
  await stop();
  await db.stop();
});

const like = (fromAccountId: string, toAccountId: string) =>
  call(client.like({ fromAccountId, toAccountId }));
const block = (blockerAccountId: string, blockedAccountId: string) =>
  call(client.block({ blockerAccountId, blockedAccountId }));
const relationship = (accountId: string, otherAccountId: string) =>
  call(client.getRelationship({ accountId, otherAccountId }));
const visible = async (viewerAccountId: string, candidateAccountIds: string[]) =>
  (await call(client.filterVisible({ viewerAccountId, candidateAccountIds }))).visibleAccountIds ??
  [];
const matchesOf = async (accountId: string) =>
  (await call(client.listMatches({ accountId }))).matches ?? [];
const NO_MATCH = { matched: false, matchId: '' };

/** Events written for these members, oldest first. */
async function events(...accountIds: string[]): Promise<string[]> {
  const { rows } = await db.pool.query<{ topic: string }>(
    `select topic from matching.outbox
      where payload::text like any ($1) order by created_at, topic`,
    [accountIds.map((id) => `%${id}%`)],
  );
  return rows.map((r) => r.topic);
}

describe('likes and matches', () => {
  it('matches on a like back, once, and says so to both', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    expect(await like(a, b)).toEqual(NO_MATCH);
    const matched = await like(b, a);
    expect(matched.matched).toBe(true);
    expect(await like(a, b)).toEqual(matched);
    expect((await matchesOf(a)).map((m) => [m.matchId, m.otherAccountId])).toEqual([
      [matched.matchId, b],
    ]);
    expect(await events(a, b)).toEqual(['match.created']);
    const { rows } = await db.pool.query<{ payload: { data: { accountIds: string[] } } }>(
      `select payload from matching.outbox where topic = 'match.created' and payload::text like $1`,
      [`%${a}%`],
    );
    expect(rows[0]?.payload.data.accountIds).toEqual(ordered(a, b));
  });

  it('creates one match when both like at the same moment', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const results = await Promise.all([like(a, b), like(b, a), like(a, b), like(b, a)]);
    expect(new Set(results.filter((r) => r.matched).map((r) => r.matchId)).size).toBe(1);
    expect(await events(a, b)).toEqual(['match.created']);
  });

  it('does not match after a pass', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await call(client.pass({ fromAccountId: a, toAccountId: b }));
    expect(await like(b, a)).toEqual(NO_MATCH);
  });

  it('refuses liking yourself and bad ids', async () => {
    const a = randomUUID();
    expect(await grpcError(like(a, a))).toBe(status.INVALID_ARGUMENT);
    expect(await grpcError(like(a, 'nope'))).toBe(status.INVALID_ARGUMENT);
  });

  it('pages matches newest first', async () => {
    const me = randomUUID();
    const others = Array.from({ length: 3 }, () => randomUUID());
    for (const other of others) {
      await like(me, other);
      await like(other, me);
    }
    const first = await call(client.listMatches({ accountId: me, pageSize: 2 }));
    const second = await call(
      client.listMatches({ accountId: me, pageSize: 2, pageToken: first.nextPageToken }),
    );
    expect(
      [...(first.matches ?? []), ...(second.matches ?? [])].map((m) => m.otherAccountId),
    ).toEqual([...others].reverse());
    expect(second.nextPageToken).toBe('');
  });
});

describe('unmatch (final, approved)', () => {
  it('ends the match for both, and the pair never matches again', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await like(a, b);
    const { matchId } = await like(b, a);
    await call(client.unmatch({ accountId: b, matchId }));
    await call(client.unmatch({ accountId: b, matchId })); // idempotent
    expect(await matchesOf(a)).toEqual([]);
    expect(await relationship(a, b)).toEqual({ blocked: false, activeMatchId: '' });
    expect(await like(a, b)).toEqual(NO_MATCH);
    expect(await like(b, a)).toEqual(NO_MATCH);
    expect(await events(a, b)).toEqual(['match.created', 'match.ended']);
  });

  it('refuses a match that is not yours', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await like(a, b);
    const { matchId } = await like(b, a);
    expect(await grpcError(call(client.unmatch({ accountId: randomUUID(), matchId })))).toBe(
      status.NOT_FOUND,
    );
  });
});

describe('blocks (M3.1 AC: hidden from each other everywhere)', () => {
  it('ends the match, clears likes, and hides both from each other', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await like(a, b);
    await like(b, a);
    await block(b, a);
    await block(b, a); // idempotent

    expect(await relationship(a, b)).toEqual({ blocked: true, activeMatchId: '' });
    expect(await relationship(b, a)).toEqual({ blocked: true, activeMatchId: '' });
    expect(await visible(a, [b, c])).toEqual([c]);
    expect(await visible(b, [a, c])).toEqual([c]);
    expect(await matchesOf(a)).toEqual([]);
    // block.created and match.ended share the block's transaction, so they sort by topic.
    expect(await events(a, b)).toEqual(['match.created', 'block.created', 'match.ended']);
    const { rows } = await db.pool.query(
      'select 1 from matching.likes where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)',
      [a, b],
    );
    expect(rows).toEqual([]);
    // Either side liking does nothing, and leaves nothing behind.
    expect(await like(a, b)).toEqual(NO_MATCH);
    expect(await like(b, a)).toEqual(NO_MATCH);
    const { rows: after } = await db.pool.query('select 1 from matching.likes where from_id = $1', [
      a,
    ]);
    expect(after).toEqual([]);
  });

  it('can be undone by the blocker, restoring nothing', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await like(a, b);
    await like(b, a);
    await block(a, b);
    expect(
      (await call(client.listBlocked({ accountId: a }))).blocked?.map((x) => x.accountId),
    ).toEqual([b]);
    // Only the blocker can undo it.
    await call(client.unblock({ blockerAccountId: b, blockedAccountId: a }));
    expect((await relationship(a, b)).blocked).toBe(true);
    await call(client.unblock({ blockerAccountId: a, blockedAccountId: b }));
    expect(await relationship(a, b)).toEqual({ blocked: false, activeMatchId: '' });
    // They had matched before: no rematch.
    await like(a, b);
    expect(await like(b, a)).toEqual(NO_MATCH);
  });

  it('after unblocking members who never matched, they can meet again', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await block(a, b);
    await call(client.unblock({ blockerAccountId: a, blockedAccountId: b }));
    await like(a, b);
    expect((await like(b, a)).matched).toBe(true);
  });

  it('caps filter requests at 500', async () => {
    const ids = Array.from({ length: 501 }, () => randomUUID());
    expect(
      await grpcError(
        call(client.filterVisible({ viewerAccountId: randomUUID(), candidateAccountIds: ids })),
      ),
    ).toBe(status.INVALID_ARGUMENT);
  });
});

describe('events', () => {
  it('reach Kafka through the outbox relay, as ids only', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await like(a, b);
    const { matchId } = await like(b, a);
    await expect
      .poll(() => bus.published.some((p) => p.key === matchId), { timeout: 5_000 })
      .toBe(true);
    const sent = bus.published.find((p) => p.key === matchId);
    expect(sent?.topic).toBe('match.created');
    expect(Object.keys((sent?.event as { data: object }).data).sort()).toEqual([
      'accountIds',
      'matchId',
    ]);
  });
});
