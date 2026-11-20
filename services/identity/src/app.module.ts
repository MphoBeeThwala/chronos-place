import type { Logger } from '@chronos/logger';
import { ReadinessRegistry, SERVICE_CONFIG, SERVICE_LOGGER } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy, type Type } from '@nestjs/common';
import { IDENTITY_RUNTIME, IdentityController } from './identity.controller.js';
import {
  createIdentityRuntime,
  type IdentityConfig,
  type IdentityRuntime,
  type RuntimeOverrides,
} from './runtime.js';

/**
 * Root module of the identity service (ADR-0018). Tests pass overrides for the edges (SMS sender,
 * signing key, key wrapper); production uses none.
 */
export function createAppModule(overrides: RuntimeOverrides = {}): Type {
  @Module({
    controllers: [IdentityController],
    providers: [
      {
        provide: IDENTITY_RUNTIME,
        inject: [SERVICE_CONFIG, SERVICE_LOGGER, ReadinessRegistry],
        useFactory: (config: IdentityConfig, logger: Logger, readiness: ReadinessRegistry) =>
          createIdentityRuntime(config, logger, readiness, overrides),
      },
    ],
  })
  class AppModule implements OnModuleDestroy {
    readonly #runtime: IdentityRuntime;

    constructor(@Inject(IDENTITY_RUNTIME) runtime: IdentityRuntime) {
      this.#runtime = runtime;
    }

    /** Runs after the servers stop, during graceful shutdown. */
    async onModuleDestroy(): Promise<void> {
      await this.#runtime.close();
    }
  }
  return AppModule;
}
