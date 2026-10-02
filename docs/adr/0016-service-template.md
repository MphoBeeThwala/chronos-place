# ADR-0016: Service template, telemetry and container image

## Decisions
**Service kit** (`@chronos/service-kit`) is the one way services start. A service provides a Nest module; the kit provides validated config (exits on bad config), the redacting logger, request ids, HTTP probes (`/healthz`, `/readyz`), the gRPC server with the standard `grpc.health.v1` service, safe error mapping, graceful shutdown and telemetry. New services are generated from `tools/templates/service` (`pnpm new:service <name>`); no placeholder service lives in `services/`.

- **Fastify** serves the HTTP probe endpoints (and webhooks, where a service needs them). gRPC is the API transport.
- **Decorators:** `experimentalDecorators` is on and `emitDecoratorMetadata` is off. Always inject with `@Inject(TOKEN_OR_CLASS)`. This keeps tests (esbuild) and builds (tsc) identical.
- **Errors:** services throw `DomainError` with a fixed, generic message. Anything else becomes `INTERNAL` / HTTP 500 with a generic body; the detail goes to the redacting logger only.
- **Shutdown:** report not-ready, drain (default 5 s), stop servers (gRPC `tryShutdown` finishes in-flight calls), close dependencies in reverse registration order, flush telemetry, exit. A hard timeout (default 25 s, below the Kubernetes grace period) exits 1.
- **mTLS:** gRPC TLS certificate, key and client CA are required outside local and test. The per-method allow-list is M2.5.

**Telemetry** (OpenTelemetry, OTLP over HTTP)
- Only HTTP and gRPC are instrumented. Database, Redis and Kafka instrumentation arrives with those clients and must not capture statements.
- A scrubbing exporter wraps the OTLP exporter: span and event attributes go through the logger's redaction, query strings and statements are dropped, `exception.message`, `exception.stacktrace` and span status messages are removed (error text can echo input).
- Resource detection is limited to `OTEL_RESOURCE_ATTRIBUTES`. The default process detector exports command-line arguments, which can carry secrets.
- Under ES modules, OpenTelemetry must be registered before `http` and `@grpc/grpc-js` load. Services run `node --import @chronos/service-kit/instrument dist/main.js`; the bootstrap reuses the telemetry that preload started. Probe requests are not traced.
- Packages are pinned to the 0.2xx experimental line; upgrade them together.

**Container image**
- Multi-stage build with `pnpm deploy --prod`; final stage `gcr.io/distroless/nodejs22-debian12:nonroot` pinned by digest, user 65532, no shell, read-only root filesystem.
- Trivy runs with `--severity HIGH,CRITICAL --exit-code 1`. The ignore file stays empty unless an entry has a reason and an expiry date. Scans run in CI (M0.9); the local script runs them where Trivy is installed.

## Consequences
The kit couples services to NestJS, which the stack already requires. Changing probe, shutdown or telemetry behaviour is a change to one package, tested once.
