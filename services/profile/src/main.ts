import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { createAppModule } from './app.module.js';
import { profileConfig } from './config.js';
import { PROFILE_PACKAGE, PROFILE_PROTO } from './proto.js';

// Validated config, probes, request ids, safe errors, graceful shutdown and telemetry come from the kit.
await bootstrapService({
  module: createAppModule(),
  extraConfig: profileConfig,
  grpc: { packageName: PROFILE_PACKAGE, protoPath: PROFILE_PROTO },
});
