import type { Logger } from '@chronos/logger';
import { ReadinessRegistry, SERVICE_CONFIG, SERVICE_LOGGER } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy, type Type } from '@nestjs/common';
import { DISCOVERY_RUNTIME, DiscoveryController } from './discovery.controller.js';
import {
  createDiscoveryRuntime,
  type DiscoveryConfig,
  type DiscoveryRuntime,
  type RuntimeOverrides,
} from './runtime.js';

/** Root module of the discovery service (TASKS M3.2, ADR-0026). */
export function createAppModule(overrides: RuntimeOverrides = {}): Type {
  @Module({
    controllers: [DiscoveryController],
    providers: [
      {
        provide: DISCOVERY_RUNTIME,
        inject: [SERVICE_CONFIG, ReadinessRegistry, SERVICE_LOGGER],
        useFactory: (config: DiscoveryConfig, readiness: ReadinessRegistry, logger: Logger) =>
          createDiscoveryRuntime(config, readiness, logger, overrides),
      },
    ],
  })
  class AppModule implements OnModuleDestroy {
    readonly #runtime: DiscoveryRuntime;

    constructor(@Inject(DISCOVERY_RUNTIME) runtime: DiscoveryRuntime) {
      this.#runtime = runtime;
    }

    async onModuleDestroy(): Promise<void> {
      await this.#runtime.close();
    }
  }
  return AppModule;
}
