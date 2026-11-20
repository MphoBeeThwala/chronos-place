import type { AccountRecord, AccountStore, NewAccount } from '../../src/accounts/account-store.js';
import type { AccountStatus } from '../../src/db/schema.js';
import type { OutboxEvent } from '../../src/events/outbox.js';

export class InMemoryAccountStore implements AccountStore {
  readonly rows = new Map<
    string,
    NewAccount & { status: AccountStatus; dateOfBirth: string | null }
  >();

  #record(id: string): AccountRecord | undefined {
    const row = this.rows.get(id);
    return row && { id, status: row.status, hasDateOfBirth: row.dateOfBirth !== null };
  }

  findByPhoneLookup(lookup: Buffer): Promise<AccountRecord | undefined> {
    const row = [...this.rows.values()].find((r) => r.phoneLookup.equals(lookup));
    return Promise.resolve(row && this.#record(row.id));
  }

  get(id: string): Promise<AccountRecord | undefined> {
    return Promise.resolve(this.#record(id));
  }

  readonly events: OutboxEvent[] = [];

  insertPending(account: NewAccount, events: readonly OutboxEvent[]): Promise<boolean> {
    if ([...this.rows.values()].some((r) => r.phoneLookup.equals(account.phoneLookup)))
      return Promise.resolve(false);
    this.rows.set(account.id, { ...account, status: 'pending_onboarding', dateOfBirth: null });
    this.events.push(...events);
    return Promise.resolve(true);
  }

  activateWithDateOfBirth(id: string, isoDate: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.status !== 'pending_onboarding' || row.dateOfBirth !== null)
      return Promise.resolve(false);
    row.status = 'active';
    row.dateOfBirth = isoDate;
    return Promise.resolve(true);
  }

  markIneligible(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.status !== 'pending_onboarding') return Promise.resolve(false);
    row.status = 'ineligible';
    return Promise.resolve(true);
  }
}
