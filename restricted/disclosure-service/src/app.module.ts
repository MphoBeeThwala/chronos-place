import { ReadinessRegistry, SERVICE_CONFIG } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import {
  createDisclosureRuntime,
  type DisclosureConfig,
  type DisclosureRuntime,
} from './runtime.js';

export const DISCLOSURE_RUNTIME = Symbol('DISCLOSURE_RUNTIME');

/**
 * Root module of the Disclosure Service, the only door to the Health Vault (ADR-0002). Its gRPC
 * API arrives in the next M2.2 change; for now it opens the vault and reports readiness.
 */
@Module({
  providers: [
    {
      provide: DISCLOSURE_RUNTIME,
      inject: [SERVICE_CONFIG, ReadinessRegistry],
      useFactory: (config: DisclosureConfig, readiness: ReadinessRegistry) =>
        createDisclosureRuntime(config, readiness),
    },
  ],
})
export class AppModule implements OnModuleDestroy {
  readonly #runtime: DisclosureRuntime;

  constructor(@Inject(DISCLOSURE_RUNTIME) runtime: DisclosureRuntime) {
    this.#runtime = runtime;
  }

  /** Runs after the servers stop, during graceful shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.#runtime.close();
  }
}
