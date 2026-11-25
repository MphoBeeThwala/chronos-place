import { createEvent } from '@chronos/contracts/events';
import { describe, expect, it } from 'vitest';
import { deduped, InMemoryEventBus, InMemoryProcessedEvents } from '../src/index.js';

const ACCOUNT = '0b5f6a9e-3f0c-4c55-8f53-6a2a4f1c2d01';
const erasure = () =>
  createEvent('account.erasure_requested', 'identity', {
    accountId: ACCOUNT,
    requestedAt: new Date().toISOString(),
  });

describe('InMemoryEventBus', () => {
  it('delivers validated events in order', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe('account.erasure_requested', (e) => {
      seen.push(e.eventId);
      return Promise.resolve();
    });
    const events = [erasure(), erasure(), erasure()];
    for (const e of events) await bus.publish(e.type, ACCOUNT, e);
    await bus.drain();
    expect(seen).toEqual(events.map((e) => e.eventId));
  });

  it('refuses an event that breaks its contract', async () => {
    const bus = new InMemoryEventBus();
    await expect(
      bus.publish('account.erasure_requested', ACCOUNT, { ...erasure(), data: { accountId: 'x' } }),
    ).rejects.toThrow();
    expect(bus.published).toEqual([]);
  });

  it('redelivers while a handler throws, and records one that never succeeds', async () => {
    const bus = new InMemoryEventBus({ maxAttempts: 3 });
    let calls = 0;
    bus.subscribe('account.erasure_requested', () => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error('not yet')) : Promise.resolve();
    });
    await bus.publish('account.erasure_requested', ACCOUNT, erasure());
    await bus.drain();
    expect(calls).toBe(3);
    expect(bus.failures).toEqual([]);

    const stuck = new InMemoryEventBus({ maxAttempts: 2 });
    stuck.subscribe('account.erasure_requested', () => Promise.reject(new Error('never')));
    await stuck.publish('account.erasure_requested', ACCOUNT, erasure());
    await stuck.drain();
    expect(stuck.failures).toHaveLength(1);
  });
});

describe('deduped', () => {
  it('handles each eventId once', async () => {
    let calls = 0;
    const handler = deduped(new InMemoryProcessedEvents(), () => {
      calls += 1;
      return Promise.resolve();
    });
    const event = erasure();
    await handler(event);
    await handler(event);
    await handler(erasure());
    expect(calls).toBe(2);
  });

  it('does not mark an event handled when the work fails', async () => {
    let calls = 0;
    const handler = deduped(new InMemoryProcessedEvents(), () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('fail')) : Promise.resolve();
    });
    const event = erasure();
    await expect(handler(event)).rejects.toThrow('fail');
    await handler(event);
    expect(calls).toBe(2);
  });
});
