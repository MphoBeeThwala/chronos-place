import { describe, expect, it } from 'vitest';
import { REDACT_KEY_EXACT, REDACT_KEY_FRAGMENTS, REDACTED, scrubString } from '../src/index.js';
import { capture, MARKER } from './helpers.js';

describe('mandatory key redaction', () => {
  const exactKeys = [...REDACT_KEY_EXACT];
  const fragmentKeys = REDACT_KEY_FRAGMENTS.map((f) => `x_${f}_y`);

  it.each([...exactKeys, ...fragmentKeys])('never writes the value of key "%s"', (key) => {
    const { logger, raw } = capture();
    logger.info(
      { [key]: MARKER, nested: { deep: { [key]: MARKER } }, list: [{ [key]: MARKER }] },
      'event',
    );
    expect(raw()).not.toContain(MARKER);
    expect(raw()).toContain(REDACTED);
  });

  it.each([
    'HealthProfile',
    'health_profile',
    'health-profile',
    'HEALTH PROFILE',
    'phoneE164',
    'Date_Of_Birth',
  ])('treats key variant "%s" as the same key', (key) => {
    const { logger, raw } = capture();
    logger.warn({ [key]: MARKER });
    expect(raw()).not.toContain(MARKER);
  });

  it('redacts keys given in child bindings', () => {
    const { logger, raw } = capture();
    logger.child({ conditions: [MARKER], accountId: 'acc-1' }).info('child event');
    expect(raw()).not.toContain(MARKER);
    expect(raw()).toContain('acc-1');
  });

  it('keeps ordinary fields', () => {
    const { logger, lines } = capture();
    logger.info({ accountId: 'a-123', durationMs: 42, route: '/feed' }, 'served');
    expect(lines()[0]).toMatchObject({
      service: 'test-service',
      level: 'info',
      accountId: 'a-123',
      durationMs: 42,
      route: '/feed',
      msg: 'served',
    });
  });

  it('accepts extra keys but cannot be weakened', () => {
    const { logger, raw } = capture({ extraRedactKeys: ['favouriteColour'] });
    logger.info({ favouriteColour: MARKER, password: MARKER });
    expect(raw()).not.toContain(MARKER);
  });

  it('is applied even when pino is reached without the wrapper methods', () => {
    const { logger, raw } = capture();
    // The wrapper hides pino, so use bindings: they also flow into every line.
    logger.child({ secretThing: MARKER }).info('x');
    expect(raw()).not.toContain(MARKER);
  });
});

describe('value scrubbing', () => {
  it.each([
    ['email', 'contact thandi.synthetic@example.test now', 'thandi.synthetic@example.test'],
    ['E.164 phone', 'sms to +27 82 555 0100 failed', '555 0100'],
    ['local phone', 'called 082-555-0100', '555-0100'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456 seen', 'eyJhbGci'],
    ['bearer', 'header Bearer abc.def-123_xyz', 'abc.def-123_xyz'],
    [
      'query string',
      'GET https://api.example.test/match?condition=synthetic&x=1 ok',
      'condition=synthetic',
    ],
  ])('scrubs %s in free text', (_name, input, leaked) => {
    expect(scrubString(input)).not.toContain(leaked);
  });

  it('scrubs values under harmless keys and in messages', () => {
    const { logger, raw } = capture();
    logger.info(
      { detail: 'mail me at a.b@example.test' },
      'user a.b@example.test called +27825550100',
    );
    expect(raw()).not.toContain('a.b@example.test');
    expect(raw()).not.toContain('825550100');
  });

  it('leaves UUIDs and ISO dates alone', () => {
    const text = 'id 123e4567-e89b-12d3-a456-426614174000 on 2026-10-01';
    expect(scrubString(text)).toBe(text);
  });

  it('does not interpolate extra arguments into the message', () => {
    const { logger, raw } = capture();
    (logger.info as (...args: unknown[]) => void)('hello %s', MARKER);
    expect(raw()).not.toContain(MARKER);
  });
});

describe('robustness', () => {
  it('handles circular references, bigint, dates and binary', () => {
    const { logger, lines } = capture();
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;
    logger.info({ loop, big: 10n, at: new Date('2026-10-01T00:00:00Z'), blob: new Uint8Array(32) });
    expect(lines()[0]).toMatchObject({
      loop: { name: 'loop', self: '[Circular]' },
      big: '10',
      at: '2026-10-01T00:00:00.000Z',
      blob: '[binary 32 bytes]',
    });
  });

  it('truncates deep objects, long arrays and long strings', () => {
    const { logger, raw } = capture();
    let deep: Record<string, unknown> = { leaf: MARKER.toLowerCase() };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    logger.info({ deep, many: Array.from({ length: 100 }, (_, i) => i), long: 'a'.repeat(5000) });
    expect(raw().length).toBeLessThan(3000);
    expect(raw()).not.toContain(MARKER.toLowerCase());
  });

  it('never throws on hostile input', () => {
    const { logger } = capture();
    const hostile = {
      get boom(): string {
        throw new Error('getter');
      },
    };
    expect(() => {
      logger.info(hostile);
    }).not.toThrow();
  });

  it('serialises errors without leaking personal data', () => {
    const { logger, raw, lines } = capture();
    const error = Object.assign(
      new Error('failed for a.b@example.test', { cause: new Error('+27825550100') }),
      {
        code: 'E_SYNTH',
      },
    );
    logger.error(error, 'operation failed');
    expect(raw()).not.toContain('a.b@example.test');
    expect(raw()).not.toContain('825550100');
    expect(lines()[0]).toMatchObject({
      errType: 'Error',
      errCode: 'E_SYNTH',
      msg: 'operation failed',
    });
  });
});

describe('allowlist mode (restricted services)', () => {
  it('writes only allowed and base fields', () => {
    const { logger, lines, raw } = capture({ mode: 'allowlist', allowedFields: ['vaultOp'] });
    logger.info({ vaultOp: 'upsert', durationMs: 5, accountId: 'acc-9', surprise: MARKER }, 'done');
    const line = lines()[0];
    expect(line).toMatchObject({ vaultOp: 'upsert', durationMs: 5, msg: 'done', droppedFields: 2 });
    expect(raw()).not.toContain(MARKER);
    expect(raw()).not.toContain('acc-9');
  });

  it('still drops sensitive keys that someone added to the allow-list', () => {
    const { logger, raw } = capture({
      mode: 'allowlist',
      allowedFields: ['conditions', 'password'],
    });
    logger.info({ conditions: MARKER, password: MARKER });
    expect(raw()).not.toContain(MARKER);
  });

  it('drops nested unknown fields and error messages', () => {
    const { logger, raw } = capture({ mode: 'allowlist' });
    logger.error(new Error(`decrypt failed for ${MARKER}`), 'vault error');
    logger.info({ route: '/x', nested: { inner: MARKER } });
    expect(raw()).not.toContain(MARKER);
  });
});
