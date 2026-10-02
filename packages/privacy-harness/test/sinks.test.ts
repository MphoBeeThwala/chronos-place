import { describe, expect, it } from 'vitest';
import {
  createPrivacyHarness,
  EventSink,
  GrpcSink,
  NotificationSink,
  PrivacyLeakError,
} from '../src/index.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('NotificationSink policy', () => {
  it('accepts generic text and id-only data', () => {
    const sink = new NotificationSink();
    sink.send({
      channel: 'push',
      to: 'device-1',
      title: 'Chronos',
      body: 'You have a new message',
      data: { type: 'message', conversationId: ID },
    });
    sink.send({
      channel: 'push',
      to: 'device-1',
      title: 'Chronos',
      body: 'You have a new match',
      data: { matchId: ID },
    });
    expect(sink.policyFindings()).toEqual([]);
  });

  it.each([
    ['a name in the body', { title: 'Chronos', body: 'Thandi sent you a message' }],
    ['a name in the title', { title: 'Thandi', body: 'You have a new message' }],
    ['message content', { title: 'Chronos', body: 'You have a new message: hello' }],
  ])('rejects %s', (_name, content) => {
    const sink = new NotificationSink();
    sink.send({ channel: 'push', to: 'device-1', ...content });
    expect(sink.policyFindings()).toHaveLength(1);
  });

  it('rejects data that is not an id or a plain type', () => {
    const sink = new NotificationSink();
    sink.send({
      channel: 'push',
      to: 'd',
      title: 'Chronos',
      body: 'You have a new message',
      data: { senderName: 'Thandi', matchId: 'not-a-uuid', type: 'A message with spaces' },
    });
    expect(sink.policyFindings().map((f) => f.detail)).toEqual([
      expect.stringContaining('"senderName"'),
      expect.stringContaining('"matchId"'),
      expect.stringContaining('"type"'),
    ]);
  });

  it('applies to email and SMS as well', () => {
    const sink = new NotificationSink();
    sink.send({
      channel: 'sms',
      to: '+27 82 555 0100',
      title: 'Chronos',
      body: 'Your code is 123456',
    });
    expect(sink.policyFindings()).toHaveLength(1);
  });
});

describe('harness', () => {
  it('is clean when nothing was captured', () => {
    expect(() => {
      createPrivacyHarness({ seed: 's' }).assertClean();
    }).not.toThrow();
  });

  it('fails with the sink, the kind, the encoding and the seed', () => {
    const harness = createPrivacyHarness({ seed: 'repro-seed' });
    harness.events.publish('match.created', {
      extra: Buffer.from(harness.markers.conditionCode()).toString('hex'),
    });
    try {
      harness.assertClean();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PrivacyLeakError);
      const message = (error as Error).message;
      expect(message).toContain('PRIVACY_SEED=repro-seed');
      expect(message).toContain('[events]');
      expect(message).toContain('(health)');
      expect(message).toContain('hex');
    }
  });

  it('scans every sink, including ones added later', () => {
    const harness = createPrivacyHarness({ seed: 'sinks' });
    const secret = harness.markers.secret();
    harness.grpc.recordError({ code: 13, details: `boom ${secret}` });
    harness.http.record({ method: 'GET', url: `/x?token=${secret}`, status: 200, body: '' });
    const custom = new EventSink();
    harness.addSink(custom);
    expect(harness.scan().map((f) => f.sink)).toEqual(expect.arrayContaining(['grpc', 'http']));
    expect(new GrpcSink().texts()).toEqual([]);
  });
});
