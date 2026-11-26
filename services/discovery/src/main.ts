import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { DISCOVERY_ALLOW_LIST } from './allow-list.js';
import { createAppModule } from './app.module.js';
import { discoveryConfig } from './config.js';
import { DISCOVERY_PACKAGE, DISCOVERY_PROTO } from './proto.js';

// Validated config, probes, request ids, safe errors, graceful shutdown and telemetry come from the kit.
await bootstrapService({
  module: createAppModule(),
  extraConfig: discoveryConfig,
  grpc: { packageName: DISCOVERY_PACKAGE, protoPath: DISCOVERY_PROTO },
  allowList: DISCOVERY_ALLOW_LIST,
});
