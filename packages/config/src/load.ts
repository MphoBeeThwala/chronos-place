import { readFileSync } from 'node:fs';
import type { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

export interface LoadOptions {
  /** Defaults to `process.env`. Pass an object in tests. */
  env?: Env;
  /** Defaults to reading UTF-8 from disk. Used for `NAME_FILE` secrets (Kubernetes mounts). */
  readFile?: (path: string) => string;
}

/**
 * Thrown when configuration is invalid. The message names the variables and the rule each one broke.
 * It never contains the values, because they may be secrets.
 */
export class ConfigError extends Error {
  readonly issues: readonly { variable: string; problem: string }[];

  constructor(issues: readonly { variable: string; problem: string }[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  ${i.variable}: ${i.problem}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type EffectSchema = z.ZodType<Record<string, unknown>>;

interface SchemaDef {
  shape?: Record<string, unknown>;
  in?: z.ZodType;
  left?: z.ZodType;
  right?: z.ZodType;
}

/** Finds the variable names a schema declares, looking through refinements and intersections. */
function declaredKeys(schema: z.ZodType): string[] {
  const def = (schema as unknown as { def: SchemaDef }).def;
  if (def.shape) return Object.keys(def.shape);
  return [def.in, def.left, def.right].flatMap((inner) => (inner ? declaredKeys(inner) : []));
}

/**
 * Resolves `NAME_FILE=/path` into `NAME` for declared variables only, so secrets can be mounted as files.
 * Setting both `NAME` and `NAME_FILE` is an error.
 */
function applyFileSecrets(
  keys: readonly string[],
  env: Env,
  readFile: (path: string) => string,
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = { ...env };
  const issues: { variable: string; problem: string }[] = [];
  for (const key of keys) {
    const filePath = env[`${key}_FILE`];
    if (filePath === undefined || filePath === '') continue;
    if (env[key] !== undefined) {
      issues.push({ variable: key, problem: `set both directly and through ${key}_FILE` });
      continue;
    }
    try {
      resolved[key] = readFile(filePath).replace(/\r?\n$/, '');
    } catch {
      issues.push({ variable: `${key}_FILE`, problem: 'file could not be read' });
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return resolved;
}

/** Parses and validates configuration. Throws `ConfigError` listing every problem at once. */
export function loadConfig<S extends EffectSchema>(
  schema: S,
  options: LoadOptions = {},
): Readonly<z.output<S>> {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const input = applyFileSecrets(declaredKeys(schema), env, readFile);

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: issue.path.length > 0 ? String(issue.path[0]) : '(config)',
        // Required-variable errors read "expected string, received undefined"; no user value is ever echoed.
        problem:
          issue.code === 'invalid_type' && input[String(issue.path[0])] === undefined
            ? 'is required'
            : issue.message,
      })),
    );
  }
  return Object.freeze(result.data);
}

/**
 * For service entry points: loads config, or prints the problems to stderr and exits with code 1.
 * A service must refuse to start on invalid configuration.
 */
export function loadConfigOrExit<S extends EffectSchema>(
  schema: S,
  options: LoadOptions = {},
): Readonly<z.output<S>> {
  try {
    return loadConfig(schema, options);
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : 'Invalid configuration: could not be loaded';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
