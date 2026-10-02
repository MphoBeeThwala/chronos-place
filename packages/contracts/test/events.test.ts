import { isSensitiveKey } from '@chronos/logger';
import { describe, expect, it } from 'vitest';
import {
  ContractError,
  createEvent,
  eventJsonSchemas,
  eventSchemas,
  parseEvent,
  partitionKey,
  producersOf,
  TOPICS,
  type Topic,
} from '../src/events/index.js';

const MARKER = 'SYNTHETIC-MARKER-7f3a9c';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-02T10:00:00.000Z');

const samples: Record<Topic, { producer: string; data: Record<string, unknown> }> = {
  'account.created': { producer: 'identity', data: { accountId: A, createdAt: NOW.toISOString() } },
  'account.erasure_requested': {
    producer: 'identity',
    data: { accountId: A, requestedAt: NOW.toISOString() },
  },
  'account.erasure_confirmed': { producer: 'profile', data: { accountId: A, service: 'profile' } },
  'account.erased': { producer: 'identity', data: { accountId: A } },
  'match.created': { producer: 'matching', data: { matchId: M, accountIds: [A, B] } },
  'match.ended': { producer: 'matching', data: { matchId: M, accountIds: [A, B] } },
  'block.created': { producer: 'matching', data: { blockerId: A, blockedId: B } },
  'report.created': {
    producer: 'moderation',
    data: { reportId: M, subjectId: A, severity: 'high' },
  },
  'photo.uploaded': { producer: 'profile', data: { photoId: M, accountId: A } },
  'entitlement.changed': { producer: 'payments', data: { accountId: A, tier: 'plus' } },
};

const valid = (topic: Topic): unknown => ({
  eventId: M,
  type: topic,
  version: 1,
  occurredAt: NOW.toISOString(),
  producer: samples[topic].producer,
  data: samples[topic].data,
});

describe('event catalog', () => {
  it('covers every topic in TECHNICAL_SPEC section 7 (plus erasure confirmation)', () => {
    expect([...TOPICS].sort()).toEqual(
      [
        'account.created',
        'account.erasure_requested',
        'account.erasure_confirmed',
        'account.erased',
        'match.created',
        'match.ended',
        'block.created',
        'report.created',
        'photo.uploaded',
        'entitlement.changed',
      ].sort(),
    );
  });

  describe.each(TOPICS)('%s', (topic) => {
    it('accepts a valid event', () => {
      expect(parseEvent(topic, valid(topic))).toMatchObject({ type: topic, version: 1 });
    });

    it('rejects an unknown field in the envelope or the payload', () => {
      const event = valid(topic) as Record<string, unknown>;
      expect(() => parseEvent(topic, { ...event, extra: MARKER })).toThrow(ContractError);
      expect(() =>
        parseEvent(topic, { ...event, data: { ...(event['data'] as object), extra: MARKER } }),
      ).toThrow(ContractError);
    });

    it('rejects missing and wrongly typed fields', () => {
      const event = valid(topic) as Record<string, unknown>;
      expect(() => parseEvent(topic, { ...event, eventId: 'not-a-uuid' })).toThrow(ContractError);
      expect(() => parseEvent(topic, { ...event, occurredAt: 'yesterday' })).toThrow(ContractError);
      expect(() => parseEvent(topic, { ...event, version: 2 })).toThrow(ContractError);
      expect(() => parseEvent(topic, { ...event, type: 'other.topic' })).toThrow(ContractError);
      expect(() => parseEvent(topic, { ...event, data: {} })).toThrow(ContractError);
      expect(() => parseEvent(topic, { ...event, data: undefined })).toThrow(ContractError);
      expect(() => parseEvent(topic, null)).toThrow(ContractError);
    });

    it('rejects a producer that does not own the topic', () => {
      const event = valid(topic) as Record<string, unknown>;
      const owners = producersOf(topic) as readonly string[];
      expect(owners).toContain(samples[topic].producer);
      expect(() => parseEvent(topic, { ...event, producer: 'gateway' })).toThrow(ContractError);
    });

    it('survives a JSON round trip (Kafka encoding)', () => {
      const event = parseEvent(topic, valid(topic));
      expect(parseEvent(topic, JSON.parse(JSON.stringify(event)))).toEqual(event);
    });
  });

  it('requires match pairs to be two distinct ids in ascending order', () => {
    const base = valid('match.created') as { data: object };
    for (const accountIds of [[B, A], [A, A], [A], [A, B, M]]) {
      expect(() =>
        parseEvent('match.created', { ...base, data: { matchId: M, accountIds } }),
      ).toThrow(ContractError);
    }
  });

  it('restricts enumerations', () => {
    const report = valid('report.created') as { data: object };
    expect(() =>
      parseEvent('report.created', { ...report, data: { ...report.data, severity: 'urgent' } }),
    ).toThrow();
    const entitlement = valid('entitlement.changed') as { data: object };
    expect(() =>
      parseEvent('entitlement.changed', {
        ...entitlement,
        data: { ...entitlement.data, tier: 'gold' },
      }),
    ).toThrow();
  });

  it('lets only the owning service publish each topic', () => {
    expect(producersOf('match.created')).toEqual(['matching']);
    expect(producersOf('account.created')).toEqual(['identity']);
    expect(producersOf('account.erasure_confirmed').length).toBeGreaterThan(1);
  });
});

describe('createEvent', () => {
  it('builds a valid event with a fresh id and the supplied time', () => {
    const one = createEvent(
      'account.created',
      'identity',
      { accountId: A, createdAt: NOW.toISOString() },
      { now: NOW },
    );
    const two = createEvent(
      'account.created',
      'identity',
      { accountId: A, createdAt: NOW.toISOString() },
      { now: NOW },
    );
    expect(one.occurredAt).toBe(NOW.toISOString());
    expect(one.eventId).not.toBe(two.eventId);
    expect(parseEvent('account.created', one)).toEqual(one);
  });

  it('refuses invalid payloads', () => {
    expect(() =>
      createEvent('account.created', 'identity', {
        accountId: 'nope',
        createdAt: NOW.toISOString(),
      }),
    ).toThrow(ContractError);
  });
});

describe('ContractError', () => {
  it('names the failing fields but never echoes values', () => {
    const event = valid('block.created') as { data: object };
    try {
      parseEvent('block.created', {
        ...event,
        data: { blockerId: MARKER, blockedId: B, extra: MARKER },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      const message = (error as Error).message;
      expect(message).toContain('data.blockerId');
      expect(message).not.toContain(MARKER);
      expect(JSON.stringify(error)).not.toContain(MARKER);
    }
  });
});

describe('partition keys', () => {
  it('keeps related events together', () => {
    expect(partitionKey(parseEvent('account.created', valid('account.created')))).toBe(A);
    expect(partitionKey(parseEvent('match.ended', valid('match.ended')))).toBe(M);
    expect(partitionKey(parseEvent('block.created', valid('block.created')))).toBe(A);
    expect(partitionKey(parseEvent('report.created', valid('report.created')))).toBe(M);
  });
});

describe('privacy: events carry no health data (CLAUDE.md rule 3)', () => {
  const collectKeys = (node: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(node)) node.forEach((n) => collectKeys(n, out));
    else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const props = record['properties'];
      if (props !== null && typeof props === 'object')
        Object.keys(props).forEach((k) => out.add(k));
      Object.values(record).forEach((v) => collectKeys(v, out));
    }
    return out;
  };

  it.each(TOPICS)('%s has no field name on the logger redaction list', (topic) => {
    const schema = eventJsonSchemas()[topic];
    const sensitive = [...collectKeys(schema)].filter((key) => isSensitiveKey(key));
    expect(sensitive).toEqual([]);
  });

  it('the redaction check really does flag health-like names', () => {
    for (const key of ['healthStatus', 'conditions', 'visibility', 'grantId', 'diagnosis']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('emits closed JSON Schemas (additionalProperties false) for every topic', () => {
    for (const topic of TOPICS) {
      const schema = eventJsonSchemas()[topic] as {
        additionalProperties?: boolean;
        properties: Record<string, unknown>;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(
        ['data', 'eventId', 'occurredAt', 'producer', 'type', 'version'].sort(),
      );
      expect(
        (schema.properties['data'] as { additionalProperties?: boolean }).additionalProperties,
      ).toBe(false);
    }
  });

  it('keeps the schema list and the catalog in step', () => {
    expect(Object.keys(eventJsonSchemas()).sort()).toEqual(Object.keys(eventSchemas).sort());
  });
});
