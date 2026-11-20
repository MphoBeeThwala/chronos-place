import { createLogger } from '@chronos/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { every } from '../src/maintenance/scheduler.js';

const lines: string[] = [];
const logger = createLogger({
  service: 'identity-test',
  destination: { write: (l: string) => void lines.push(l) },
});

describe('every', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lines.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never runs a task while its previous run is still going', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const stop = every(
      'slow',
      100,
      async () => {
        active += 1;
        runs += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        active -= 1;
      },
      logger,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBeGreaterThan(1);
    expect(maxActive).toBe(1);
    const stopping = stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
  });

  it('logs a failure and keeps the schedule going', async () => {
    let runs = 0;
    const stop = every(
      'flaky',
      100,
      () => {
        runs += 1;
        return Promise.reject(new Error('boom'));
      },
      logger,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBeGreaterThan(2);
    expect(lines.some((l) => l.includes('scheduled task failed'))).toBe(true);
    await stop();
  });

  it('stops for good', async () => {
    let runs = 0;
    const stop = every('once', 100, () => Promise.resolve(void (runs += 1)), logger);
    await vi.advanceTimersByTimeAsync(150);
    await stop();
    const after = runs;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(after);
  });
});
