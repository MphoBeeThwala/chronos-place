import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountId, eventEnvelope, strictObject, type Producer } from './envelope.js';

/**
 * Event schemas for Kafka topics (TECHNICAL_SPEC section 7).
 *
 * Health data is never published (CLAUDE.md rule 3). Payloads hold ids and timestamps only, and a
 * test fails if any field name matches the logger's mandatory redaction list. Disclosure changes are
 * deliberately NOT events: even "this member changed their health visibility" implies health data.
 */

const timestamp = z.iso.datetime();
const matchPair = z
  .tuple([accountId, accountId])
  .refine(([a, b]) => a < b, 'accountIds must be two distinct ids in ascending order');

export const eventSchemas = {
  'account.created': eventEnvelope(
    'account.created',
    ['identity'],
    strictObject({ accountId, createdAt: timestamp }),
  ),
  'account.erasure_requested': eventEnvelope(
    'account.erasure_requested',
    ['identity'],
    strictObject({ accountId, requestedAt: timestamp }),
  ),
  /** Each service confirms once its data is deleted; identity marks the account erased after all confirm. */
  'account.erasure_confirmed': eventEnvelope(
    'account.erasure_confirmed',
    ['profile', 'discovery', 'matching', 'messaging', 'moderation', 'notifications', 'payments'],
    strictObject({
      accountId,
      service: z.enum([
        'profile',
        'matching',
        'messaging',
        'moderation',
        'notifications',
        'payments',
        'discovery',
      ]),
    }),
  ),
  'account.erased': eventEnvelope('account.erased', ['identity'], strictObject({ accountId })),
  'match.created': eventEnvelope(
    'match.created',
    ['matching'],
    strictObject({ matchId: z.uuid(), accountIds: matchPair }),
  ),
  'match.ended': eventEnvelope(
    'match.ended',
    ['matching'],
    strictObject({ matchId: z.uuid(), accountIds: matchPair }),
  ),
  'block.created': eventEnvelope(
    'block.created',
    ['matching'],
    strictObject({ blockerId: accountId, blockedId: accountId }),
  ),
  'report.created': eventEnvelope(
    'report.created',
    ['moderation'],
    strictObject({
      reportId: z.uuid(),
      subjectId: accountId,
      severity: z.enum(['low', 'medium', 'high', 'critical']),
    }),
  ),
  'photo.uploaded': eventEnvelope(
    'photo.uploaded',
    ['profile'],
    strictObject({ photoId: z.uuid(), accountId }),
  ),
  'entitlement.changed': eventEnvelope(
    'entitlement.changed',
    ['payments'],
    strictObject({ accountId, tier: z.enum(['free', 'plus', 'premium']) }),
  ),
} as const;

export type Topic = keyof typeof eventSchemas;
export const TOPICS = Object.keys(eventSchemas) as Topic[];
export type EventOf<T extends Topic> = z.infer<(typeof eventSchemas)[T]>;
export type DataOf<T extends Topic> = EventOf<T>['data'];

/** Thrown when an event fails validation. Names the fields at fault, never their values. */
export class ContractError extends Error {
  readonly fields: readonly string[];

  constructor(topic: string, fields: readonly string[]) {
    super(`Invalid ${topic} event: ${fields.join(', ') || '(unknown)'}`);
    this.name = 'ContractError';
    this.fields = fields;
  }
}

/** Producer side: builds a valid event. Throws `ContractError` if `data` is wrong. */
export function createEvent<T extends Topic>(
  topic: T,
  producer: EventOf<T>['producer'],
  data: DataOf<T>,
  options: { eventId?: string; now?: Date } = {},
): EventOf<T> {
  const schema = eventSchemas[topic] as unknown as z.ZodType<EventOf<T>>;
  const candidate = {
    eventId: options.eventId ?? randomUUID(),
    type: topic,
    version: 1,
    occurredAt: (options.now ?? new Date()).toISOString(),
    producer,
    data,
  };
  return parseWith(topic, schema, candidate);
}

/** Consumer side: validates untrusted input (a decoded Kafka message). */
export function parseEvent<T extends Topic>(topic: T, input: unknown): EventOf<T> {
  return parseWith(topic, eventSchemas[topic] as unknown as z.ZodType<EventOf<T>>, input);
}

function parseWith<R>(topic: string, schema: z.ZodType<R>, input: unknown): R {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [
    ...new Set(result.error.issues.flatMap((i) => (i.path.length > 0 ? [i.path.join('.')] : []))),
  ];
  throw new ContractError(topic, fields);
}

/** The services allowed to publish a topic. */
export function producersOf(topic: Topic): readonly Producer[] {
  return eventSchemas[topic].shape.producer.options;
}

/**
 * Kafka partition key: keeps all events about one subject in order on one partition.
 * Account-scoped events key on the account; match events on the match; reports on the report.
 */
export function partitionKey(event: EventOf<Topic>): string {
  const data = event.data as Record<string, unknown>;
  const key =
    data['matchId'] ??
    data['reportId'] ??
    data['photoId'] ??
    data['accountId'] ??
    data['blockerId'];
  return typeof key === 'string' ? key : event.eventId;
}

/** JSON Schema for each topic, for non-TypeScript consumers and documentation. */
export function eventJsonSchemas(): Record<Topic, unknown> {
  return Object.fromEntries(
    TOPICS.map((topic) => [topic, z.toJSONSchema(eventSchemas[topic])]),
  ) as Record<Topic, unknown>;
}
