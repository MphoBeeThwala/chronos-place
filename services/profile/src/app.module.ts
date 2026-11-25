import type { Logger } from '@chronos/logger';
import { ReadinessRegistry, SERVICE_CONFIG, SERVICE_LOGGER } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy, type Type } from '@nestjs/common';
import { PROFILE_RUNTIME, ProfileController } from './profile.controller.js';
import {
  createProfileRuntime,
  type ProfileConfig,
  type ProfileRuntime,
  type RuntimeOverrides,
} from './runtime.js';

/** Root module of the profile service (ADR-0023). */
export function createAppModule(overrides: RuntimeOverrides = {}): Type {
  @Module({
    controllers: [ProfileController],
    providers: [
      {
        provide: PROFILE_RUNTIME,
        inject: [SERVICE_CONFIG, SERVICE_LOGGER, ReadinessRegistry],
        useFactory: (config: ProfileConfig, logger: Logger, readiness: ReadinessRegistry) =>
          createProfileRuntime(config, logger, readiness, overrides),
      },
    ],
  })
  class AppModule implements OnModuleDestroy {
    readonly #runtime: ProfileRuntime;

    constructor(@Inject(PROFILE_RUNTIME) runtime: ProfileRuntime) {
      this.#runtime = runtime;
    }

    /** Runs after the servers stop, during graceful shutdown. */
    async onModuleDestroy(): Promise<void> {
      await this.#runtime.close();
    }
  }
  return AppModule;
}
