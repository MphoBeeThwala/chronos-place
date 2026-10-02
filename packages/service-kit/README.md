# @chronos/service-kit

Everything a NestJS service needs to start safely. Generate a service with `pnpm new:service <name>` (M0.8 part 2), or use it directly:

```ts
// src/main.ts
import { bootstrapService } from '@chronos/service-kit';
import { z } from 'zod';
import { AppModule } from './app.module.js';

await bootstrapService({
  module: AppModule,
  extraConfig: { DATABASE_URL: postgresUrl }, // validated with the shared settings; exits on bad config
  grpc: { packageName: 'chronos.example.v1', protoPath: '...' },
});
```

```ts
// in a provider
constructor(
  @Inject(SERVICE_LOGGER) private readonly logger: Logger,
  @Inject(ReadinessRegistry) readiness: ReadinessRegistry,
) {
  readiness.register('database', () => pool.query('select 1').then(() => undefined));
}
```

| Concern   | Behaviour                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config    | `serviceConfigSchema(extra)`: shared settings (`HTTP_PORT`, `GRPC_PORT`, `SHUTDOWN_*`, `OTEL_EXPORTER_OTLP_ENDPOINT`, mTLS paths) plus yours. mTLS paths are required outside local and test. |
| Probes    | `GET /healthz` (liveness), `GET /readyz` (dependency checks; names and up/down only), gRPC `grpc.health.v1.Health/Check`.                                                                     |
| Requests  | `x-request-id` from HTTP headers or gRPC metadata if safe, else generated; on every log line; echoed on HTTP responses.                                                                       |
| Errors    | Throw `DomainError(code, 'fixed generic message')`. Anything else is `INTERNAL` with `Internal error`; detail goes to the redacting logger.                                                   |
| Shutdown  | Not ready, drain, stop servers (in-flight RPCs finish), `onClose` hooks in reverse order, flush telemetry, exit. Hard timeout exits 1.                                                        |
| Telemetry | HTTP and gRPC spans via OTLP, scrubbed before export. Run with `node --import @chronos/service-kit/instrument dist/main.js`.                                                                  |

Rules: always `@Inject(...)` (no decorator metadata); restricted services pass `loggerMode: 'allowlist'`. See ADR-0016.
