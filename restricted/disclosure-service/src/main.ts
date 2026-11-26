import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { AppModule } from './app.module.js';
import { disclosureConfig } from './config.js';

// Restricted zone: the allow-list logger, and no telemetry at all (ADR-0016, M2.2).
await bootstrapService({
  module: AppModule,
  extraConfig: disclosureConfig,
  loggerMode: 'allowlist',
  telemetry: false,
});
