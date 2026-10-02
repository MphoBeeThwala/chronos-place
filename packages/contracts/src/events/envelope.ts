import { z } from 'zod';

/** Services that produce events. Each topic names the producers allowed to publish it. */
export const PRODUCERS = [
  'identity',
  'profile',
  'discovery',
  'matching',
  'messaging',
  'moderation',
  'notifications',
  'payments',
] as const;
export type Producer = (typeof PRODUCERS)[number];

/** Every event is wrapped in this envelope. Consumers dedupe on `eventId` (TECHNICAL_SPEC 7). */
export const eventEnvelope = <
  const Topic extends string,
  const P extends readonly [Producer, ...Producer[]],
  Data extends z.ZodType,
>(
  topic: Topic,
  producers: P,
  data: Data,
) =>
  z
    .object({
      eventId: z.uuid(),
      type: z.literal(topic),
      version: z.literal(1),
      occurredAt: z.iso.datetime(),
      producer: z.enum(producers),
      data,
    })
    .strict();

export const accountId = z.uuid();

/** Strict objects: an event can never carry a field its schema does not name. */
export const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
