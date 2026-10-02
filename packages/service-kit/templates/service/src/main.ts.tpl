import 'reflect-metadata';
import { bootstrapService } from '@chronos/service-kit';
import { AppModule } from './app.module.js';

// Validated config, probes, request ids, safe errors, graceful shutdown and telemetry come from the kit.
// Add the service's API with `grpc: { packageName, protoPath }` once its contract exists in @chronos/contracts.
await bootstrapService({ module: AppModule__LOGGER_OPTION__ });
