import { ReadinessRegistry, SERVICE_CONFIG } from '@chronos/service-kit';
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
        inject: [SERVICE_CONFIG, ReadinessRegistry],
        useFactory: (config: DisclosureConfig, readiness: ReadinessRegistry) =>
          createDisclosureRuntime(config, readiness, overrides),
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
