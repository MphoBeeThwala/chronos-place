import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentRequestId, resolveRequestId, runWithRequestId } from '../src/index.js';
import { capture } from './helpers.js';

describe('request ids', () => {
  it('attaches the request id to every line, across awaits', async () => {
    const { logger, lines } = capture();
    await runWithRequestId('req-abcdef123456', async () => {
      logger.info('first');
      await new Promise((resolve) => setTimeout(resolve, 5));
      logger.info('second');
    });
    logger.info('outside');
    const [first, second, outside] = lines();
    expect(first?.['requestId']).toBe('req-abcdef123456');
    expect(second?.['requestId']).toBe('req-abcdef123456');
    expect(outside?.['requestId']).toBeUndefined();
  });

  it('isolates concurrent requests', async () => {
    const { logger, lines } = capture();
    await Promise.all(
      ['aaaaaaaa-1', 'bbbbbbbb-2'].map((id) =>
        runWithRequestId(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, id.startsWith('a') ? 10 : 1));
          logger.info({ who: id });
        }),
      ),
    );
    for (const line of lines()) expect(line['requestId']).toBe(line['who']);
  });

  it.each([
    '',
    'short',
    'has space in it',
    'a'.repeat(65),
    'line\nbreak-123456',
    '<script>alert(1)</script>',
  ])('replaces unsafe incoming id %j', (candidate) => {
    const id = resolveRequestId(candidate);
    expect(id).not.toBe(candidate);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps safe incoming ids and generates one when missing', () => {
    expect(resolveRequestId('req-abcdef123456')).toBe('req-abcdef123456');
    expect(runWithRequestId(undefined, () => currentRequestId())).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('trace correlation', () => {
  const manager = new AsyncLocalStorageContextManager();
  const provider = new BasicTracerProvider();

  beforeAll(() => {
    context.setGlobalContextManager(manager.enable());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(() => {
    manager.disable();
    context.disable();
    trace.disable();
  });

  it('adds the active trace and span ids', () => {
    const { logger, lines } = capture();
    trace.getTracer('test').startActiveSpan('work', (span) => {
      logger.info('inside span');
      const { traceId, spanId } = span.spanContext();
      expect(lines()[0]).toMatchObject({ traceId, spanId });
      span.end();
    });
    logger.info('outside span');
    expect(lines()[1]?.['traceId']).toBeUndefined();
  });
});
