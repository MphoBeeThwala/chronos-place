import {
  ContractError,
  createEvent,
  eventSchemas,
  parseEvent,
  partitionKey,
  producersOf,
  TOPICS,
  type Topic,
} from '@chronos/contracts/events';
import { describe, expect, it } from 'vitest';
import { usePrivacyHarness } from '../src/vitest.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-02T10:00:00.000Z');

const data: Record<Topic, Record<string, unknown>> = {
  'account.created': { accountId: A, createdAt: NOW.toISOString() },
  'account.erasure_requested': { accountId: A, requestedAt: NOW.toISOString() },
  'account.erasure_confirmed': { accountId: A, service: 'profile' },
  'account.erased': { accountId: A },
  'match.created': { matchId: M, accountIds: [A, B] },
  'match.ended': { matchId: M, accountIds: [A, B] },
  'block.created': { blockerId: A, blockedId: B },
  'report.created': { reportId: M, subjectId: A, severity: 'high' },
  'photo.uploaded': { photoId: M, accountId: A },
  'entitlement.changed': { accountId: A, tier: 'plus' },
};

describe('events carry ids and timestamps only', () => {
  const privacy = usePrivacyHarness();

  it.each(TOPICS)('%s: valid events are clean, and a marker cannot be smuggled in', (topic) => {
    const producer = producersOf(topic)[0] as never;
    const payload = data[topic] as never;
    const event = createEvent(topic, producer, payload, { now: NOW });
    privacy.events.publish(topic, event, partitionKey(event));

    const markers = [
      privacy.markers.healthText(),
      privacy.markers.conditionCode(),
      privacy.markers.email(),
      privacy.markers.phone(),
    ];
    for (const marker of markers) {
      // Extra fields, health-named fields, and a marker in an id slot are all rejected by the strict schemas.
      expect(() =>
        createEvent(topic, producer, { ...(payload as object), note: marker } as never),
      ).toThrow(ContractError);
      expect(() =>
        createEvent(topic, producer, { ...(payload as object), conditions: [marker] } as never),
      ).toThrow(ContractError);
      const idField = Object.keys(data[topic]).find((k) => k.endsWith('Id') || k === 'accountIds');
      if (idField) {
        const poisoned = {
          ...data[topic],
          [idField]: idField === 'accountIds' ? [marker, B] : marker,
        };
        expect(() => createEvent(topic, producer, poisoned as never)).toThrow(ContractError);
      }
      // A consumer that receives such a message rejects it, and the error does not repeat the marker.
      const envelope = { ...event, data: { ...(payload as object), note: marker } };
      try {
        parseEvent(topic, envelope);
        expect.unreachable('should have thrown');
      } catch (error) {
        privacy.logs.destination.write(
          JSON.stringify({ err: (error as Error).message, json: JSON.stringify(error) }),
        );
      }
    }
  });

  it('knows every topic it is checking', () => {
    expect(Object.keys(eventSchemas).sort()).toEqual([...TOPICS].sort());
    expect(Object.keys(data).sort()).toEqual([...TOPICS].sort());
  });
});
