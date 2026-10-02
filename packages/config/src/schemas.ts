import { z } from 'zod';
import { Secret } from './secret.js';

/** Region where all primary data must live (PRD data residency). */
export const DATA_REGION = 'af-south-1';

export const nodeEnv = z.enum(['local', 'test', 'development', 'staging', 'production']);
export type NodeEnv = z.infer<typeof nodeEnv>;

export const port = z.coerce.number().int().min(1).max(65535);

export const logLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** `true` or `false` only, so a typo cannot silently turn a flag off. */
export const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

/** A secret value, wrapped so it cannot be logged. Short values are rejected. */
export const secret = (minLength = 16): z.ZodPipe<z.ZodString, z.ZodTransform<Secret, string>> =>
  z
    .string()
    .min(minLength, `must be at least ${String(minLength)} characters`)
    .transform((value) => new Secret(value));

const urlWithProtocol = (protocols: readonly string[], label: string): z.ZodType<string> =>
  z.string().refine((value) => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, `must be a valid ${label}`);

/** PostgreSQL connection URL. Returned as a Secret because it normally embeds a password. */
export const postgresUrl = urlWithProtocol(
  ['postgres:', 'postgresql:'],
  'PostgreSQL URL',
).transform((value) => new Secret(value));

export const redisUrl = urlWithProtocol(['redis:', 'rediss:'], 'Redis URL').transform(
  (value) => new Secret(value),
);

export const httpUrl = urlWithProtocol(['http:', 'https:'], 'http(s) URL');

/** Comma-separated host:port list, e.g. Kafka brokers. */
export const hostList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()))
  .pipe(
    z.array(z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, 'each entry must be host:port')).min(1),
  );

/** AWS region. Outside local and test, data must stay in af-south-1. */
export const awsRegion = z
  .string()
  .regex(/^[a-z]{2}-[a-z]+-\d$/, 'must be an AWS region such as af-south-1');

/** Settings every service shares. Extend it with `baseSchema.extend({...})`. */
export const baseSchema = z
  .object({
    NODE_ENV: nodeEnv,
    SERVICE_NAME: z.string().min(1).max(64),
    LOG_LEVEL: logLevel.default('info'),
    AWS_REGION: awsRegion.default(DATA_REGION),
  })
  .superRefine((cfg, ctx) => {
    const strict = cfg.NODE_ENV === 'staging' || cfg.NODE_ENV === 'production';
    if (strict && cfg.AWS_REGION !== DATA_REGION) {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: `must be ${DATA_REGION} in ${cfg.NODE_ENV} (data residency)`,
      });
    }
  });
