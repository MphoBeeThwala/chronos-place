import type { Logger } from '@chronos/logger';
import { ReadinessRegistry, SERVICE_CONFIG, SERVICE_LOGGER } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy, type Type } from '@nestjs/common';
import { DISCLOSURE_RUNTIME, DisclosureController } from './disclosure.controller.js';
import {
  createDisclosureRuntime,
  type DisclosureConfig,
  type DisclosureRuntime,
  type RuntimeOverrides,
} from './runtime.js';

/** Root module of the Disclosure Service, the only door to the Health Vault (ADR-0002). */
export function createAppModule(overrides: RuntimeOverrides = {}): Type {
  @Module({
    controllers: [DisclosureController],
    providers: [
      {
        provide: DISCLOSURE_RUNTIME,
        inject: [SERVICE_CONFIG, ReadinessRegistry, SERVICE_LOGGER],
        useFactory: (config: DisclosureConfig, readiness: ReadinessRegistry, logger: Logger) =>
          createDisclosureRuntime(config, readiness, overrides, logger),
      },
    ],
  })
  class AppModule implements OnModuleDestroy {
    readonly #runtime: DisclosureRuntime;

    constructor(@Inject(DISCLOSURE_RUNTIME) runtime: DisclosureRuntime) {
      this.#runtime = runtime;
    }

    /** Runs after the servers stop, during graceful shutdown. */
    async onModuleDestroy(): Promise<void> {
      await this.#runtime.close();
    }
  }
  return AppModule;
}
