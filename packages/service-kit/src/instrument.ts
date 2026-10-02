/**
 * Preload for production: `node --import @chronos/service-kit/instrument dist/main.js`.
 *
 * OpenTelemetry can only patch `http` and `@grpc/grpc-js` under ES modules if its loader hook is
 * registered and the instrumentations exist before those modules are imported. This file does both,
 * using the same environment variables as the rest of the kit. `bootstrapService` reuses the
 * telemetry started here instead of starting its own.
 */
import { register } from 'node:module';
import { startTelemetry, TELEMETRY_KEY } from './telemetry.js';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
const serviceName = process.env['SERVICE_NAME'];
if (endpoint !== undefined && endpoint !== '' && serviceName !== undefined && serviceName !== '') {
  (globalThis as Record<symbol, unknown>)[TELEMETRY_KEY] = startTelemetry({
    serviceName,
    endpoint,
  });
}
