import type { Logger } from '@chronos/logger';
import { ReadinessRegistry, SERVICE_CONFIG, SERVICE_LOGGER } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy, type Type } from '@nestjs/common';
import { MATCHING_RUNTIME, MatchingController } from './matching.controller.js';
import {
  createMatchingRuntime,
  type MatchingConfig,
  type MatchingRuntime,
  type RuntimeOverrides,
} from './runtime.js';

/** Root module of the matching service (TASKS M3.1). */
export function createAppModule(overrides: RuntimeOverrides = {}): Type {
  @Module({
    controllers: [MatchingController],
    providers: [
      {
        provide: MATCHING_RUNTIME,
        inject: [SERVICE_CONFIG, ReadinessRegistry, SERVICE_LOGGER],
        useFactory: (config: MatchingConfig, readiness: ReadinessRegistry, logger: Logger) =>
          createMatchingRuntime(config, readiness, logger, overrides),
      },
    ],
  })
  class AppModule implements OnModuleDestroy {
    readonly #runtime: MatchingRuntime;

    constructor(@Inject(MATCHING_RUNTIME) runtime: MatchingRuntime) {
      this.#runtime = runtime;
    }

    async onModuleDestroy(): Promise<void> {
      await this.#runtime.close();
    }
  }
  return AppModule;
}
