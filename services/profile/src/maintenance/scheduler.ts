import type { Logger } from '@chronos/logger';

/**
 * Runs a task every `everyMs`, never overlapping itself, with up to 10% jitter so replicas do not
 * all wake at once. Errors are logged and the schedule continues. Returns a stop function that
 * waits for a run in progress.
 */
export function every(
  name: string,
  everyMs: number,
  task: () => Promise<unknown>,
  logger: Logger,
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, everyMs + Math.floor(Math.random() * everyMs * 0.1));
    timer.unref();
  };
  const tick = () => {
    running = task()
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.error({ err, task: name }, 'scheduled task failed');
      })
      .finally(() => {
        running = undefined;
        schedule();
      });
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
