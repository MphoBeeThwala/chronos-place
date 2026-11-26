# @chronos/service-kit

Everything a NestJS service needs to start safely. Generate a service with `pnpm new:service <name>` (add `--restricted` for `restricted/`), or use it directly:

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

## Generating a service

```sh
pnpm new:service profile              # services/profile
pnpm new:service vault-api --restricted   # restricted/vault-api, allow-list logger
pnpm install
pnpm --filter @chronos/profile test
```

The generated service has config, probes, shutdown and telemetry from the kit, a test that boots it, and a Dockerfile (build from the repo root). `pnpm test:service-template` proves the whole path, including the image: non-root, no shell, read-only filesystem, clean SIGTERM, Trivy clean.

## Caller allow-list (M2.5)

```ts
await bootstrapService({
  module: AppModule,
  grpc: { packageName: 'chronos.disclosure.v1', protoPath },
  allowList: {
    service: 'chronos.disclosure.v1.DisclosureService',
    methods: {
      GetOwnHealthProfile: ['gateway'],
      ViewHealthProfile: ['gateway', { caller: 'moderation', when: (req) => isModeration(req) }],
    },
  },
});
```

- **Identity:** the caller is the service named in its verified client certificate
  (`spiffe://<GRPC_TRUST_DOMAIN>/<service>`, see ADR-0004).
- **Default deny:** an unlisted method, an unlisted caller and a call without a client certificate
  all get `PERMISSION_DENIED` before the handler runs. The gRPC health service is exempt.
- **Required** outside local and test for any service with a gRPC API.
- **Clients:** `grpcClientCredentials(config, 'identity')` sends this service's certificate and
  refuses a server that isn't `identity`.
- **Certificates:** `@chronos/service-kit/pki` makes a CA and service certificates for development
  (`pnpm dev:certs`) and tests. Never use it for deployed environments.
