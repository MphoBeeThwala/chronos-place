import { baseSchema, httpUrl, port } from '@chronos/config';
import { z } from 'zod';

const kitShape = z.object({
  HTTP_PORT: port.default(8080),
  GRPC_PORT: port.default(50051),
  /** Time to keep serving after readiness flips to "not ready", so load balancers stop sending traffic. */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(30_000).default(5_000),
  /** Hard limit for the whole shutdown. Must be below the orchestrator's termination grace period. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.optional(),
  GRPC_TLS_CERT_PATH: z.string().min(1).optional(),
  GRPC_TLS_KEY_PATH: z.string().min(1).optional(),
  GRPC_TLS_CA_PATH: z.string().min(1).optional(),
});

/**
 * Settings every service shares, plus the service's own. Outside local and test, gRPC must use mTLS
 * (ADR-0004): a certificate, key and client CA are all required.
 */
export function serviceConfigSchema<Extra extends z.ZodRawShape>(extra?: Extra) {
  return baseSchema
    .and(kitShape)
    .and(z.object(extra ?? ({} as Extra)))
    .superRefine((cfg, ctx) => {
      if (cfg.NODE_ENV === 'local' || cfg.NODE_ENV === 'test') return;
      for (const key of ['GRPC_TLS_CERT_PATH', 'GRPC_TLS_KEY_PATH', 'GRPC_TLS_CA_PATH'] as const) {
        if (cfg[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `is required in ${cfg.NODE_ENV} (mTLS)`,
          });
        }
      }
    });
}

export type ServiceConfig<Extra extends z.ZodRawShape = z.ZodRawShape> = z.output<
  ReturnType<typeof serviceConfigSchema<Extra>>
>;
