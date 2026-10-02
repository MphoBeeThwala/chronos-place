import { status } from '@grpc/grpc-js';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { createLogger } from '@chronos/logger';
import { describe, expect, it, vi } from 'vitest';
import {
  DomainError,
  INTERNAL_MESSAGE,
  ReadinessRegistry,
  ShutdownCoordinator,
  toPublicError,
} from '../src/index.js';
import { MARKER } from './helpers.js';

const silentLogger = createLogger({ service: 'test', destination: { write: () => undefined } });

describe('ReadinessRegistry', () => {
  it('is ready with no checks, and reflects each check', async () => {
    const registry = new ReadinessRegistry();
    expect(await registry.check()).toEqual({ ready: true, checks: {} });
    registry.register('db', () => Promise.resolve());
    registry.register('kafka', () => Promise.reject(new Error(MARKER)));
    const result = await registry.check();
    expect(result).toEqual({ ready: false, checks: { db: 'up', kafka: 'down' } });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('treats a slow check as down after its timeout', async () => {
    const registry = new ReadinessRegistry();
    registry.register('slow', () => new Promise<void>((resolve) => setTimeout(resolve, 500)), {
      timeoutMs: 20,
    });
    const started = Date.now();
    expect((await registry.check()).checks).toEqual({ slow: 'down' });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('is never ready once shutdown has begun', async () => {
    const registry = new ReadinessRegistry();
    registry.register('db', () => Promise.resolve());
    registry.beginShutdown();
    expect(await registry.check()).toEqual({ ready: false, checks: { db: 'up' } });
  });
});

describe('toPublicError', () => {
  it('passes domain errors through with the right codes', () => {
    expect(toPublicError(new DomainError('permission_denied', 'Not allowed'))).toEqual({
      grpcCode: status.PERMISSION_DENIED,
      httpCode: 403,
      message: 'Not allowed',
    });
    expect(toPublicError(new DomainError('aborted', 'Version conflict')).grpcCode).toBe(
      status.ABORTED,
    );
  });

  it('keeps framework HTTP statuses but replaces their messages', () => {
    const result = toPublicError(new NotFoundException(`Cannot GET /secret/${MARKER}`));
    expect(result).toEqual({ grpcCode: status.NOT_FOUND, httpCode: 404, message: 'Not found' });
    expect(toPublicError(new BadRequestException(MARKER)).message).toBe('Bad request');
    expect(toPublicError(new HttpException(MARKER, 503)).httpCode).toBe(500);
  });

  it('turns everything else into a generic internal error', () => {
    for (const thrown of [
      new Error(MARKER),
      new TypeError(MARKER),
      MARKER,
      { message: MARKER },
      null,
      undefined,
    ]) {
      const result = toPublicError(thrown);
      expect(result).toEqual({
        grpcCode: status.INTERNAL,
        httpCode: 500,
        message: INTERNAL_MESSAGE,
      });
    }
  });
});

describe('ShutdownCoordinator', () => {
  const setup = (overrides: Partial<ConstructorParameters<typeof ShutdownCoordinator>[0]> = {}) => {
    const calls: string[] = [];
    const exits: number[] = [];
    const readiness = new ReadinessRegistry();
    const coordinator = new ShutdownCoordinator({
      readiness,
      logger: silentLogger,
      drainMs: 10,
      timeoutMs: 1_000,
      closeServers: () => {
        calls.push('servers');
        return Promise.resolve();
      },
      finalize: () => {
        calls.push('finalize');
        return Promise.resolve();
      },
      exit: (code) => exits.push(code),
      sleep: () => {
        calls.push(`drain (not ready: ${String(readiness.shuttingDown)})`);
        return Promise.resolve();
      },
      ...overrides,
    });
    return { coordinator, calls, exits, readiness };
  };

  it('runs the steps in order: not ready, drain, servers, hooks in reverse, finalize', async () => {
    const { coordinator, calls, exits } = setup();
    coordinator.onClose('a', () => {
      calls.push('a');
    });
    coordinator.onClose('b', () => {
      calls.push('b');
    });
    await coordinator.shutdown('SIGTERM');
    expect(calls).toEqual(['drain (not ready: true)', 'servers', 'b', 'a', 'finalize']);
    expect(exits).toEqual([0]);
  });

  it('exits 1 at the hard timeout when a step hangs', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, exits } = setup({
        timeoutMs: 1_000,
        closeServers: () => new Promise<void>(() => undefined),
        sleep: () => Promise.resolve(),
      });
      const done = coordinator.shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(1_001);
      await done;
      expect(exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs once however many signals arrive', async () => {
    const { coordinator, exits } = setup();
    await Promise.all([
      coordinator.shutdown('SIGTERM'),
      coordinator.shutdown('SIGINT'),
      coordinator.shutdown('SIGTERM'),
    ]);
    expect(exits).toEqual([0]);
  });
});
