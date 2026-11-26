import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { MATCHING_ALLOW_LIST } from './allow-list.js';
import { createAppModule } from './app.module.js';
import { matchingConfig } from './config.js';
import { MATCHING_PACKAGE, MATCHING_PROTO } from './proto.js';

// Validated config, probes, request ids, safe errors, graceful shutdown and telemetry come from the kit.
await bootstrapService({
  module: createAppModule(),
  extraConfig: matchingConfig,
  grpc: { packageName: MATCHING_PACKAGE, protoPath: MATCHING_PROTO },
  allowList: MATCHING_ALLOW_LIST,
});
