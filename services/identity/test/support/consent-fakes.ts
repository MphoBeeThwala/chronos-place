import type {
  ConsentEffects,
  ConsentEntry,
  ConsentStore,
} from '../../src/consent/consent-store.js';
import type { ConsentType } from '../../src/db/schema.js';

export class InMemoryConsentStore implements ConsentStore {
  readonly rows: (ConsentEntry & { id: string; accountId: string })[] = [];
  readonly effects: ConsentEffects[] = [];

  record(
    id: string,
    accountId: string,
    entry: ConsentEntry,
    effects: ConsentEffects,
  ): Promise<void> {
    this.rows.push({ ...entry, id, accountId });
    this.effects.push(effects);
    return Promise.resolve();
  }

  history(accountId: string): Promise<ConsentEntry[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.accountId === accountId)
        .map(({ type, policyVersion, granted, recordedAt }) => ({
          type,
          policyVersion,
          granted,
          recordedAt,
        })),
    );
  }

  latest(accountId: string): Promise<Partial<Record<ConsentType, ConsentEntry>>> {
    const latest: Partial<Record<ConsentType, ConsentEntry>> = {};
    for (const row of this.rows) if (row.accountId === accountId) latest[row.type] = row;
    return Promise.resolve(latest);
  }
}
