import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { createAppModule } from './app.module.js';
import { disclosureConfig } from './config.js';
import { DISCLOSURE_PACKAGE, DISCLOSURE_PROTO } from './proto.js';

// Restricted zone: the allow-list logger, and no telemetry at all (ADR-0016, M2.2).
await bootstrapService({
  module: createAppModule(),
  extraConfig: disclosureConfig,
  grpc: { packageName: DISCLOSURE_PACKAGE, protoPath: DISCLOSURE_PROTO },
  loggerMode: 'allowlist',
  telemetry: false,
});
