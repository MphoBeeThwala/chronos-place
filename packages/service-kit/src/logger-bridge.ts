import type { Logger } from '@chronos/logger';
import type { LoggerService } from '@nestjs/common';

const text = (message: unknown): string =>
  typeof message === 'string' ? message : 'non-string log message';

/** Sends NestJS framework logs through the redacting logger. */
export class NestLoggerBridge implements LoggerService {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ component: 'nest' });
  }

  log(message: unknown): void {
    this.#logger.info(text(message));
  }

  error(message: unknown): void {
    this.#logger.error(text(message));
  }

  warn(message: unknown): void {
    this.#logger.warn(text(message));
  }

  debug(message: unknown): void {
    this.#logger.debug(text(message));
  }

  verbose(message: unknown): void {
    this.#logger.trace(text(message));
  }

  fatal(message: unknown): void {
    this.#logger.fatal(text(message));
  }
}
