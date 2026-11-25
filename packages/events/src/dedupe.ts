import type { EventOf, Topic } from '@chronos/contracts/events';
import type { EventHandler, ProcessedEvents } from './types.js';

/** Wraps a handler so each eventId is handled once (spec 7: consumers are idempotent). */
export function deduped<T extends Topic>(
  processed: ProcessedEvents,
  handler: EventHandler<T>,
): EventHandler<T> {
  return async (event: EventOf<T>) => {
    await processed.once(event.eventId, () => handler(event));
  };
}

/** For tests and single-process development: remembers handled ids in memory. */
export class InMemoryProcessedEvents implements ProcessedEvents {
  readonly #seen = new Set<string>();

  async once(eventId: string, work: () => Promise<void>): Promise<boolean> {
    if (this.#seen.has(eventId)) return false;
    await work();
    this.#seen.add(eventId);
    return true;
  }
}
