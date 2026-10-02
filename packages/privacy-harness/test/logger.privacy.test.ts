import { inspect } from 'node:util';
import {
  createLogger,
  REDACT_KEY_EXACT,
  REDACT_KEY_FRAGMENTS,
  runWithRequestId,
  type LogMode,
} from '@chronos/logger';
import { describe, expect, it } from 'vitest';
import { usePrivacyHarness } from '../src/vitest.js';

describe('the redacting logger keeps markers out of the logs', () => {
  const privacy = usePrivacyHarness();
  const logger = (mode?: LogMode) =>
    createLogger({
      service: 'privacy',
      level: 'trace',
      ...(mode ? { mode } : {}),
      destination: privacy.logs.destination,
    });

  /** One of each kind of marker, as a value a careless caller might log. */
  const everything = (): string[] => {
    const m = privacy.markers;
    return [m.healthText(), m.conditionCode(), m.email(), m.phone(), m.coordinate(), m.secret()];
  };

  it.each([...REDACT_KEY_EXACT, ...REDACT_KEY_FRAGMENTS.map((fragment) => `x_${fragment}_y`)])(
    'under the sensitive key "%s", at any depth',
    (key) => {
      const values = everything();
      logger().info({ [key]: values, nested: { deeper: [{ [key]: values[0] }] } }, 'event');
      expect(privacy.logs.texts().join('')).toContain('[REDACTED]');
    },
  );

  it('scrubs emails and phone numbers even under harmless keys and in messages', () => {
    const { email, phone } = { email: privacy.markers.email(), phone: privacy.markers.phone() };
    logger().info({ detail: `contact ${email}`, other: phone }, `lookup for ${email} and ${phone}`);
  });

  it('through child loggers and their bindings', () => {
    const child = logger().child({
      conditions: privacy.markers.conditionCode(),
      accountId: 'acc-1',
    });
    child.warn({ phone: privacy.markers.phone() }, 'child event');
  });

  it('through errors, causes and request context', () => {
    const email = privacy.markers.email();
    const error = Object.assign(
      new Error(`failed for ${email}`, { cause: new Error(privacy.markers.phone()) }),
      { code: 'E_X' },
    );
    runWithRequestId('req-privacy-12345', () => {
      logger().error(error, `operation failed for ${email}`);
    });
  });

  it('for a restricted service in allow-list mode: unknown fields, notes and error text are dropped', () => {
    const restricted = logger('allowlist');
    restricted.info(
      {
        durationMs: 12,
        accountId: privacy.markers.conditionCode(),
        note: privacy.markers.healthText(),
        conditions: everything(),
      },
      'vault read',
    );
    restricted.error(
      new Error(`decrypt failed for ${privacy.markers.healthText()}`),
      'vault error',
    );
    restricted
      .child({ subject: privacy.markers.healthText() })
      .info({ extra: privacy.markers.conditionCode() }, 'child');
  });

  it('never interpolates extra arguments into a message', () => {
    (logger().info as (...args: unknown[]) => void)('hello %s', privacy.markers.healthText());
  });

  it('keeps secrets from config out of every textual form', async () => {
    const { Secret } = await import('@chronos/config');
    const secret = new Secret(privacy.markers.secret());
    logger().info(
      { detail: String(secret), json: JSON.stringify({ secret }), shown: inspect({ secret }) },
      `secret ${secret.toString()}`,
    );
  });
});
