import { createLogger, type Logger, type LoggerOptions } from '../src/index.js';

export interface Capture {
  logger: Logger;
  /** Raw text written so far. */
  raw: () => string;
  /** Parsed JSON lines. */
  lines: () => Record<string, unknown>[];
}

export function capture(options: Partial<LoggerOptions> = {}): Capture {
  const chunks: string[] = [];
  const logger = createLogger({
    service: 'test-service',
    level: 'trace',
    destination: { write: (chunk: string) => void chunks.push(chunk) },
    ...options,
  });
  return {
    logger,
    raw: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** A synthetic marker. Real health data is never used in tests (CLAUDE.md rule 6). */
export const MARKER = 'SYNTHETIC-MARKER-7f3a9c';
