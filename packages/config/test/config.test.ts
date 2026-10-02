import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  baseSchema,
  ConfigError,
  flag,
  hostList,
  loadConfig,
  port,
  postgresUrl,
  redisUrl,
  Secret,
  secret,
} from '../src/index.js';

const SECRET_VALUE = 'synthetic-secret-value-0123456789';

const schema = baseSchema.and(
  z.object({
    PORT: port.default(3000),
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    KAFKA_BROKERS: hostList,
    SIGNING_SECRET: secret(),
    FEATURE_X: flag.default(false),
  }),
);

const valid = {
  NODE_ENV: 'local',
  SERVICE_NAME: 'profile',
  DATABASE_URL: 'postgres://user:synthetic-password@localhost:5432/db',
  REDIS_URL: 'redis://:synthetic-password@localhost:6379',
  KAFKA_BROKERS: 'localhost:19092, redpanda:9092',
  SIGNING_SECRET: SECRET_VALUE,
};

const without = (env: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([k]) => k !== key));

describe('loadConfig', () => {
  it('parses, applies defaults and coerces types', () => {
    const config = loadConfig(schema, { env: { ...valid, PORT: '8080', FEATURE_X: 'true' } });
    expect(config.PORT).toBe(8080);
    expect(config.FEATURE_X).toBe(true);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.AWS_REGION).toBe('af-south-1');
    expect(config.KAFKA_BROKERS).toEqual(['localhost:19092', 'redpanda:9092']);
  });

  it('returns a frozen object', () => {
    const config = loadConfig(schema, { env: valid });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reports every missing variable at once, by name', () => {
    expect.assertions(3);
    try {
      loadConfig(schema, { env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const names = (error as ConfigError).issues.map((i) => i.variable);
      expect(names).toEqual(
        expect.arrayContaining([
          'NODE_ENV',
          'SERVICE_NAME',
          'DATABASE_URL',
          'REDIS_URL',
          'KAFKA_BROKERS',
          'SIGNING_SECRET',
        ]),
      );
      expect((error as ConfigError).message).toContain('DATABASE_URL: is required');
    }
  });

  it.each([
    ['NODE_ENV', 'prod'],
    ['PORT', 'not-a-port'],
    ['PORT', '70000'],
    ['DATABASE_URL', 'mysql://u:synthetic-leak@h/db'],
    ['DATABASE_URL', 'not a url synthetic-leak'],
    ['REDIS_URL', 'http://synthetic-leak'],
    ['KAFKA_BROKERS', 'synthetic-leak'],
    ['SIGNING_SECRET', 'synthetic-leak'],
    ['FEATURE_X', 'yes-synthetic-leak'],
    ['LOG_LEVEL', 'verbose-synthetic-leak'],
  ])('rejects invalid %s without echoing the value', (name, value) => {
    expect.assertions(2);
    try {
      loadConfig(schema, { env: { ...valid, [name]: value } });
    } catch (error) {
      expect((error as ConfigError).issues.map((i) => i.variable)).toContain(name);
      expect((error as Error).message).not.toContain('synthetic-leak');
    }
  });

  it('never includes valid secret values in an error caused by another variable', () => {
    expect.assertions(2);
    try {
      loadConfig(schema, { env: { ...valid, PORT: 'bad' } });
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET_VALUE);
      expect((error as Error).message).not.toContain('synthetic-password');
    }
  });

  it('requires af-south-1 in staging and production', () => {
    for (const NODE_ENV of ['staging', 'production']) {
      expect(() =>
        loadConfig(schema, { env: { ...valid, NODE_ENV, AWS_REGION: 'eu-west-1' } }),
      ).toThrow(/AWS_REGION: must be af-south-1/);
    }
    expect(
      loadConfig(schema, { env: { ...valid, NODE_ENV: 'local', AWS_REGION: 'eu-west-1' } })
        .AWS_REGION,
    ).toBe('eu-west-1');
  });
});

describe('secrets', () => {
  it('cannot leak through string conversion, JSON or inspect', () => {
    const config = loadConfig(schema, { env: valid });
    expect(config.SIGNING_SECRET).toBeInstanceOf(Secret);
    const printed = [
      String(config.SIGNING_SECRET),
      config.SIGNING_SECRET.toString(),
      JSON.stringify(config),
      inspect(config, { depth: 5 }),
    ].join('\n');
    expect(printed).not.toContain(SECRET_VALUE);
    expect(printed).not.toContain('synthetic-password');
    expect(printed).toContain('[REDACTED]');
  });

  it('exposes the raw value only through reveal()', () => {
    const config = loadConfig(schema, { env: valid });
    expect(config.SIGNING_SECRET.reveal()).toBe(SECRET_VALUE);
    expect(config.DATABASE_URL.reveal()).toBe(valid.DATABASE_URL);
  });

  it('reads NAME_FILE for declared variables and trims the trailing newline', () => {
    const rest = without(valid, 'SIGNING_SECRET');
    const config = loadConfig(schema, {
      env: { ...rest, SIGNING_SECRET_FILE: '/run/secrets/signing' },
      readFile: (p) => (p === '/run/secrets/signing' ? `${SECRET_VALUE}\n` : ''),
    });
    expect(config.SIGNING_SECRET.reveal()).toBe(SECRET_VALUE);
  });

  it('rejects setting both NAME and NAME_FILE, and unreadable files', () => {
    expect(() =>
      loadConfig(schema, { env: { ...valid, SIGNING_SECRET_FILE: '/x' }, readFile: () => 'y' }),
    ).toThrow(/SIGNING_SECRET: set both directly and through SIGNING_SECRET_FILE/);
    const rest = without(valid, 'SIGNING_SECRET');
    expect(() =>
      loadConfig(schema, {
        env: { ...rest, SIGNING_SECRET_FILE: '/missing' },
        readFile: () => {
          throw new Error('ENOENT /missing synthetic-leak');
        },
      }),
    ).toThrow(/SIGNING_SECRET_FILE: file could not be read/);
  });

  it('ignores NAME_FILE for variables the schema does not declare', () => {
    const config = loadConfig(schema, {
      env: { ...valid, UNDECLARED_FILE: '/etc/passwd' },
      readFile: () => {
        throw new Error('must not be called');
      },
    });
    expect(config.SERVICE_NAME).toBe('profile');
  });
});

describe('service start-up', () => {
  const dist = path.resolve(import.meta.dirname, '../dist/index.js');
  const run = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { loadConfigOrExit, baseSchema, postgresUrl } from ${JSON.stringify(dist)};
         import { z } from 'zod';
         const cfg = loadConfigOrExit(baseSchema.and(z.object({ DATABASE_URL: postgresUrl })));
         process.stdout.write('started ' + cfg.SERVICE_NAME);`,
      ],
      {
        env: { PATH: process.env['PATH'] ?? '', ...env },
        encoding: 'utf8',
        cwd: path.resolve(import.meta.dirname, '..'),
      },
    );

  it('refuses to start with invalid configuration: exit code 1, names the problem, hides the value', () => {
    const result = run({
      NODE_ENV: 'local',
      SERVICE_NAME: 'svc',
      DATABASE_URL: 'mysql://u:synthetic-leak@h/db',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.stderr).not.toContain('synthetic-leak');
  });

  it('starts with valid configuration', () => {
    const result = run({
      NODE_ENV: 'local',
      SERVICE_NAME: 'svc',
      DATABASE_URL: 'postgres://u:p@h:5432/db',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('started svc');
  });
});
