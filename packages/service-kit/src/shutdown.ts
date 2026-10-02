import type { Logger } from '@chronos/logger';
import type { ReadinessRegistry } from './readiness.js';

export interface ShutdownOptions {
  readiness: ReadinessRegistry;
  logger: Logger;
  drainMs: number;
  timeoutMs: number;
  /** Stops accepting and finishes in-flight requests (HTTP and gRPC). */
  closeServers: () => Promise<void>;
  /** Runs last, e.g. flushing telemetry. */
  finalize?: () => Promise<void>;
  exit: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Hook = { name: string; run: () => Promise<void> | void };

/**
 * Orderly shutdown: report not-ready, drain, stop the servers, close dependencies in reverse order of
 * registration, flush telemetry, exit. A hard timeout exits with code 1 if anything hangs.
 */
export class ShutdownCoordinator {
  readonly #options: ShutdownOptions;
  readonly #hooks: Hook[] = [];
  #started: Promise<void> | undefined;

  constructor(options: ShutdownOptions) {
    this.#options = options;
  }

  /** Registers a dependency to close after the servers have stopped (database pool, Kafka client, ...). */
  onClose(name: string, run: () => Promise<void> | void): void {
    this.#hooks.push({ name, run });
  }

  /** Safe to call more than once; later calls wait for the first. */
  shutdown(signal: string): Promise<void> {
    this.#started ??= this.#run(signal);
    return this.#started;
  }

  async #run(signal: string): Promise<void> {
    const { readiness, logger, drainMs, timeoutMs, exit } = this.#options;
    const sleep =
      this.#options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    logger.info({ signal }, 'shutdown started');
    readiness.beginShutdown();

    const deadline = hardDeadline(timeoutMs);

    const graceful = (async (): Promise<'done' | 'failed'> => {
      const state = { failed: false };
      const step = async (name: string, run: () => Promise<void> | void): Promise<void> => {
        try {
          await run();
        } catch (error) {
          state.failed = true;
          logger.error(
            error instanceof Error ? error : { thrown: typeof error },
            `shutdown step failed: ${name}`,
          );
        }
      };
      await sleep(drainMs);
      await step('servers', this.#options.closeServers);
      for (const hook of [...this.#hooks].reverse()) await step(hook.name, hook.run);
      if (this.#options.finalize) await step('finalize', this.#options.finalize);
      return state.failed ? 'failed' : 'done';
    })();

    const outcome = await Promise.race([graceful, deadline.expired]);
    deadline.cancel();
    if (outcome === 'timeout') logger.error('shutdown timed out; exiting');
    else logger.info({ outcome }, 'shutdown complete');
    exit(outcome === 'done' ? 0 : 1);
  }
}

/** A promise that resolves with "timeout" after `ms`, plus a way to cancel it. The timer never keeps the process alive. */
function hardDeadline(ms: number): { expired: Promise<'timeout'>; cancel: () => void } {
  let cancel = (): void => undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout');
    }, ms);
    timer.unref();
    cancel = () => {
      clearTimeout(timer);
    };
  });
  return { expired, cancel };
}
