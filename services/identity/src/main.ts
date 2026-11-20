import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { createAppModule } from './app.module.js';
import { identityConfig } from './config.js';
import { IDENTITY_PACKAGE, IDENTITY_PROTO } from './proto.js';

// Validated config, probes, request ids, safe errors, graceful shutdown and telemetry come from the kit.
await bootstrapService({
  module: createAppModule(),
  extraConfig: identityConfig,
  grpc: { packageName: IDENTITY_PACKAGE, protoPath: IDENTITY_PROTO },
});
