import { createEvent, type EventOf } from '@chronos/contracts/events';
import type { SubjectKeyring } from '@chronos/crypto';
import type { Logger } from '@chronos/logger';
import { metrics } from '@opentelemetry/api';
import type { ErasureStore } from './erasure-store.js';

/** Erasure still waiting after this long is flagged for staff (ADR-0025 f). */
export const OVERDUE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 50;

export interface ErasureServiceDeps {
  store: ErasureStore;
  keyring: SubjectKeyring;
  /** Every service that stores member data and must confirm (configuration). */
  services: readonly string[];
  /** Asks the verification worker to delete captures and vendor copies (it needs the key). */
  forgetVerification: (accountId: string) => Promise<void>;
  logger: Logger;
  now?: () => Date;
}

/**
 * Finishes account erasure (spec 7, ADR-0025 e). Services confirm with account.erasure_confirmed;
 * once all expected ones have, and identity's own verification files are gone, identity shreds the
 * account's data key, deletes everything else and leaves only the bare id, status erased.
 */
export class ErasureService {
  readonly #d: Required<ErasureServiceDeps>;
  #overdue = 0;

  constructor(deps: ErasureServiceDeps) {
    this.#d = { now: () => new Date(), ...deps };
    // No ids or labels: just how many are waiting too long. Exported once metrics are set up.
    metrics
      .getMeter('identity')
      .createObservableGauge('erasure_overdue', {
        description: 'Accounts still waiting for erasure after 7 days',
      })
      .addCallback((result) => {
        result.observe(this.#overdue);
      });
  }

  /** Handles account.erasure_confirmed. Safe to repeat; ignored for services not expected. */
  async confirmed(event: EventOf<'account.erasure_confirmed'>): Promise<void> {
    const { accountId, service } = event.data;
    if (!this.#d.services.includes(service)) return;
    if (await this.#d.store.confirm(accountId, service, this.#d.now())) {
      this.#d.logger.info({ accountId, service }, 'erasure confirmed by service');
    }
  }

  /** Finishes every ready account, then counts overdue ones. Returns how many finished. */
  async runOnce(): Promise<number> {
    let finished = 0;
    for (const ready of await this.#d.store.ready(this.#d.services, BATCH)) {
      if (ready.capturesRemain) {
        // Idempotent: makes sure the purge is requested, then waits for the worker.
        await this.#d.forgetVerification(ready.accountId);
        continue;
      }
      if (await this.#finish(ready.accountId)) finished += 1;
    }
    const now = this.#d.now();
    this.#overdue = await this.#d.store.overdue(new Date(now.getTime() - OVERDUE_AFTER_MS));
    if (this.#overdue > 0) {
      this.#d.logger.warn({ count: this.#overdue }, 'account erasure overdue');
    }
    return finished;
  }

  async #finish(accountId: string): Promise<boolean> {
    const now = this.#d.now();
    // Shred first: if the rest fails, the next run finishes it, and nothing readable remains.
    await this.#d.keyring.shred(accountId);
    const event = createEvent('account.erased', 'identity', { accountId }, { now });
    const done = await this.#d.store.finish(accountId, now, event);
    if (done) this.#d.logger.info({ accountId }, 'account erased');
    return done;
  }
}
