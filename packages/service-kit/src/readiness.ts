import { Injectable } from '@nestjs/common';

export type CheckState = 'up' | 'down';

export interface ReadinessResult {
  ready: boolean;
  /** Check names and states only. Error details never leave the process. */
  checks: Record<string, CheckState>;
}

interface Check {
  run: () => Promise<void>;
  timeoutMs: number;
}

/**
 * Dependencies register a check here (database ping, Kafka connection, ...). `/readyz` and the gRPC
 * health service report the combined result, and report not-ready as soon as shutdown begins.
 */
@Injectable()
export class ReadinessRegistry {
  readonly #checks = new Map<string, Check>();
  #shuttingDown = false;

  register(name: string, run: () => Promise<void>, options: { timeoutMs?: number } = {}): void {
    this.#checks.set(name, { run, timeoutMs: options.timeoutMs ?? 2_000 });
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  async check(): Promise<ReadinessResult> {
    const checks: Record<string, CheckState> = {};
    await Promise.all(
      [...this.#checks].map(async ([name, check]) => {
        checks[name] = await runWithTimeout(check);
      }),
    );
    const allUp = Object.values(checks).every((state) => state === 'up');
    return { ready: allUp && !this.#shuttingDown, checks };
  }
}

async function runWithTimeout(check: Check): Promise<CheckState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, check.timeoutMs);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
