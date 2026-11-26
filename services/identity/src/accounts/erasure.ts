import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accounts, outbox, vaultErasureRequests } from '../db/schema.js';
import { type OutboxEvent, outboxValues } from '../events/outbox.js';

export interface StartErasure {
  accountId: string;
  now: Date;
  /** Idempotency key for the health-data erasure request (Disclosure Service, M2). */
  vaultRequestId: string;
  /** account.erasure_requested, built by the caller. */
  events: OutboxEvent[];
}

/**
 * Starts account erasure inside the caller's transaction (ADR-0025): the account becomes
 * pending_erasure, its number's lookup hash is cleared so the number can open a new account, health
 * erasure is queued and account.erasure_requested goes to the outbox. Only accounts a member can
 * use are changed; returns false when the account was already past that (a repeat does nothing).
 */
export async function startErasure(
  tx: Pick<NodePgDatabase, 'update' | 'insert'>,
  { accountId, now, vaultRequestId, events }: StartErasure,
): Promise<boolean> {
  const started = await tx
    .update(accounts)
    .set({
      status: 'pending_erasure',
      erasureRequestedAt: now,
      phoneLookup: null,
      updatedAt: now,
    })
    .where(
      and(eq(accounts.id, accountId), inArray(accounts.status, ['pending_onboarding', 'active'])),
    )
    .returning({ id: accounts.id });
  if (started.length === 0) return false;
  await tx.insert(vaultErasureRequests).values({ id: vaultRequestId, accountId });
  if (events.length > 0) await tx.insert(outbox).values(events.map(outboxValues));
  return true;
}
