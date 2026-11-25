import type { EventOf, Topic } from '@chronos/contracts/events';

/** Sends one event. Delivery is at least once; consumers dedupe on eventId (spec 7). */
export interface EventPublisher {
  publish(topic: string, key: string, event: unknown): Promise<void>;
}

/** Handles one validated event. Throwing means "not done": the event is delivered again. */
export type EventHandler<T extends Topic> = (event: EventOf<T>) => Promise<void>;

/** Receives events for the topics a service subscribes to, in order per partition key. */
export interface EventSubscriber {
  subscribe<T extends Topic>(topic: T, handler: EventHandler<T>): void;
  /** Starts receiving. Call after every subscribe. */
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Remembers which events a service has handled, so a redelivered event is skipped. Services back
 * it with a table written in the same transaction as the handler's own changes.
 */
export interface ProcessedEvents {
  /** Runs `work` unless `eventId` was already handled, then records it. True when it ran. */
  once(eventId: string, work: () => Promise<void>): Promise<boolean>;
}
