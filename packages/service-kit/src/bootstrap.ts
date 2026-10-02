import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadConfigOrExit, type Env } from '@chronos/config';
import { createLogger, type Logger, type LogMode } from '@chronos/logger';
import { ServerCredentials } from '@grpc/grpc-js';
import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { z } from 'zod';
import { serviceConfigSchema, type ServiceConfig } from './config.js';
import { SafeExceptionFilter } from './errors.js';
import { HealthGrpcController, HealthHttpController } from './health.js';
import { NestLoggerBridge } from './logger-bridge.js';
import { ReadinessRegistry } from './readiness.js';
import { RequestContextInterceptor } from './request-context.js';
import { ShutdownCoordinator } from './shutdown.js';
import { startTelemetry, TELEMETRY_KEY, type Telemetry } from './telemetry.js';
import { SERVICE_CONFIG, SERVICE_LOGGER } from './tokens.js';

const HEALTH_PROTO = path.resolve(import.meta.dirname, '../proto/grpc/health/v1/health.proto');

export interface ServiceOptions<Extra extends z.ZodRawShape> {
  /** The service's root Nest module. */
  module: Type<unknown>;
  /** The service's own environment variables, merged with the shared ones. */
  extraConfig?: Extra;
  /** The service's gRPC API. The standard health service is always added. */
  grpc?: { packageName: string; protoPath: string | string[] };
  /** `allowlist` for services under restricted/ (ADR-0002). */
  loggerMode?: LogMode;
  // The options below exist for tests.
  env?: Env;
  logger?: Logger;
  onInvalidConfig?: 'exit' | 'throw';
  installSignalHandlers?: boolean;
  exit?: (code: number) => void;
}

export interface RunningService<Extra extends z.ZodRawShape = z.ZodRawShape> {
  app: NestFastifyApplication;
  config: ServiceConfig<Extra>;
  logger: Logger;
  readiness: ReadinessRegistry;
  /** Registers a dependency to close after the servers stop. Runs in reverse order of registration. */
  onClose: (name: string, run: () => Promise<void> | void) => void;
  shutdown: (signal?: string) => Promise<void>;
}

function grpcCredentials(config: {
  GRPC_TLS_CERT_PATH?: string | undefined;
  GRPC_TLS_KEY_PATH?: string | undefined;
  GRPC_TLS_CA_PATH?: string | undefined;
}) {
  const { GRPC_TLS_CERT_PATH: cert, GRPC_TLS_KEY_PATH: key, GRPC_TLS_CA_PATH: ca } = config;
  if (cert === undefined || key === undefined) return ServerCredentials.createInsecure();
  // Third argument: require and verify client certificates (mTLS).
  return ServerCredentials.createSsl(
    ca === undefined ? null : readFileSync(ca),
    [{ private_key: readFileSync(key), cert_chain: readFileSync(cert) }],
    ca !== undefined,
  );
}

function kitModule(parts: {
  config: unknown;
  logger: Logger;
  readiness: ReadinessRegistry;
}): DynamicModule {
  @Global()
  @Module({})
  class KitModule {}
  return {
    module: KitModule,
    controllers: [HealthHttpController, HealthGrpcController],
    providers: [
      { provide: SERVICE_CONFIG, useValue: parts.config },
      { provide: SERVICE_LOGGER, useValue: parts.logger },
      { provide: ReadinessRegistry, useValue: parts.readiness },
      { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    ],
    exports: [SERVICE_CONFIG, SERVICE_LOGGER, ReadinessRegistry],
  };
}

/**
 * Starts a service: validated config (exits on bad config), redacting logger, telemetry, an HTTP
 * server for probes, a gRPC server, request ids, safe errors and graceful shutdown.
 */
export async function bootstrapService<Extra extends z.ZodRawShape = z.ZodRawShape>(
  options: ServiceOptions<Extra>,
): Promise<RunningService<Extra>> {
  const schema = serviceConfigSchema(options.extraConfig);
  const loadOptions = options.env ? { env: options.env } : {};
  const config = (
    options.onInvalidConfig === 'throw'
      ? loadConfig(schema, loadOptions)
      : loadConfigOrExit(schema, loadOptions)
  ) as ServiceConfig<Extra>;

  const logger =
    options.logger ??
    createLogger({
      service: config.SERVICE_NAME,
      level: config.LOG_LEVEL,
      mode: options.loggerMode ?? 'redact',
    });
  // `node --import @chronos/service-kit/instrument` starts telemetry before any module is loaded.
  const preloaded = (globalThis as Record<symbol, unknown>)[TELEMETRY_KEY] as Telemetry | undefined;
  const telemetry =
    preloaded ??
    startTelemetry({
      serviceName: config.SERVICE_NAME,
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    });
  const readiness = new ReadinessRegistry();

  @Module({ imports: [kitModule({ config, logger, readiness }), options.module] })
  class RootModule {}

  const app = await NestFactory.create<NestFastifyApplication>(RootModule, new FastifyAdapter(), {
    logger: new NestLoggerBridge(logger),
  });
  app.useGlobalFilters(new SafeExceptionFilter(logger));

  const protoPaths = [HEALTH_PROTO, ...(options.grpc ? [options.grpc.protoPath].flat() : [])];
  const packages = ['grpc.health.v1', ...(options.grpc ? [options.grpc.packageName] : [])];
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        package: packages,
        protoPath: protoPaths,
        url: `0.0.0.0:${String(config.GRPC_PORT)}`,
        credentials: grpcCredentials(config),
        // Finish in-flight RPCs on shutdown instead of cutting them off.
        gracefulShutdown: true,
      },
    },
    { inheritAppConfig: true },
  );

  const coordinator = new ShutdownCoordinator({
    readiness,
    logger,
    drainMs: config.SHUTDOWN_DRAIN_MS,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    closeServers: () => app.close(),
    finalize: () => telemetry.shutdown(),
    exit: options.exit ?? ((code) => process.exit(code)),
  });

  await app.startAllMicroservices();
  await app.listen(config.HTTP_PORT, '0.0.0.0');
  logger.info({ httpPort: config.HTTP_PORT, grpcPort: config.GRPC_PORT }, 'service started');

  if (options.installSignalHandlers ?? true) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void coordinator.shutdown(signal);
      });
    }
  }

  return {
    app,
    config,
    logger,
    readiness,
    onClose: (name, run) => {
      coordinator.onClose(name, run);
    },
    shutdown: (signal = 'manual') => coordinator.shutdown(signal),
  };
}
