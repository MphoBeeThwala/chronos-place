import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { createAppModule } from './app.module.js';
import { gatewayConfig } from './config.js';

// HTTP only: the gateway serves GraphQL at /graphql and has no gRPC API of its own.
await bootstrapService({ module: createAppModule(), extraConfig: gatewayConfig });
