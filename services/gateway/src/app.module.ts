import { readFileSync } from 'node:fs';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { schemaPath } from '@chronos/contracts/graphql';
import type { Logger } from '@chronos/logger';
import { SERVICE_CONFIG, SERVICE_LOGGER } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy, type OnModuleInit, type Type } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { buildContext, type GatewayContext, type RequestLike } from './auth/context.js';
import { authGuard } from './auth/guard.js';
import { DEVELOPMENT_ENVIRONMENTS } from './config.js';
import { formatError } from './graphql/errors.js';
import { assertApproved, persistedOperationsPlugin } from './limits/persisted-operations.js';
import {
  assertRequestSize,
  complexityLimit,
  depthLimit,
  QUERY_LIMITS,
} from './limits/query-limits.js';
import { healthResolvers } from './graphql/health-resolvers.js';
import { exportResolvers } from './graphql/export-resolvers.js';
import { identityResolvers } from './graphql/identity-resolvers.js';
import { profileResolvers } from './graphql/profile-resolvers.js';
import { type ResolverMap, rootResolvers } from './graphql/not-available.js';
import { createGatewayRuntime, type GatewayConfig, type GatewayRuntime } from './runtime.js';
import { registerCaptureRoute, type RouteHost } from './verification/capture-route.js';

export const GATEWAY_RUNTIME = Symbol('GATEWAY_RUNTIME');

/** Fields served today. Others answer NOT_AVAILABLE until their services exist. */
/** Every service's resolvers, merged per root type. */
export const mergeResolvers = (...maps: ResolverMap[]): ResolverMap => {
  const merged: ResolverMap = {};
  for (const map of maps) {
    for (const [type, fields] of Object.entries(map)) merged[type] = { ...merged[type], ...fields };
  }
  return merged;
};

const defaultResolvers = (runtime: GatewayRuntime): ResolverMap =>
  mergeResolvers(
    identityResolvers(runtime),
    profileResolvers(runtime),
    exportResolvers(runtime),
    healthResolvers(runtime),
  );

const SDL = readFileSync(schemaPath, 'utf8');

export interface AppModuleOptions {
  /** Tests replace the identity client and add resolvers. */
  runtime?: (config: GatewayConfig, logger: Logger) => GatewayRuntime;
  resolvers?: (runtime: GatewayRuntime) => ResolverMap;
  /** Tests gate their own fields; defaults to VERIFIED_FIELDS from the contracts. */
  verifiedFields?: readonly string[];
}

/** Root module of the GraphQL gateway (TASKS M1.3). Clients reach it at /graphql. */
export function createAppModule(options: AppModuleOptions = {}): Type {
  @Module({
    providers: [
      {
        provide: GATEWAY_RUNTIME,
        inject: [SERVICE_CONFIG, SERVICE_LOGGER],
        useFactory: (config: GatewayConfig, logger: Logger) =>
          (options.runtime ?? createGatewayRuntime)(config, logger),
      },
    ],
    exports: [GATEWAY_RUNTIME],
  })
  class RuntimeModule {}

  @Module({
    imports: [
      RuntimeModule,
      GraphQLModule.forRootAsync<ApolloDriverConfig>({
        driver: ApolloDriver,
        imports: [RuntimeModule],
        inject: [SERVICE_CONFIG, GATEWAY_RUNTIME],
        useFactory: (config: GatewayConfig, runtime: GatewayRuntime): ApolloDriverConfig => {
          const development = (DEVELOPMENT_ENVIRONMENTS as readonly string[]).includes(
            config.NODE_ENV,
          );
          const cookieOptions = {
            secure: config.COOKIE_SECURE,
            graphqlPath: config.GRAPHQL_PUBLIC_PATH,
          };
          return {
            typeDefs: SDL,
            resolvers: rootResolvers(SDL, (options.resolvers ?? defaultResolvers)(runtime)),
            path: '/graphql',
            playground: false,
            graphiql: false,
            introspection: development,
            csrfPrevention: true,
            // Apollo's automatic persisted queries would let clients register new operations;
            // approved operations come only from the manifest (ADR-0021).
            persistedQueries: false,
            validationRules: [depthLimit(QUERY_LIMITS.maxDepth)],
            includeStacktraceInErrorResponses: false,
            formatError,
            // With Fastify, Apollo's integration passes the request and reply as two arguments.
            context: (request: RequestLike, reply: GatewayContext['reply']) =>
              buildContext(request, {
                keys: runtime.keys,
                cookieOptions,
                trustedHops: config.TRUSTED_PROXY_HOPS,
              }).then(async (ctx) => {
                // Before anything is parsed: rate limits (counting every request), size, approval.
                await runtime.rateLimiter.check(ctx.ip, ctx.viewer?.accountId);
                const body = (request as { body?: Parameters<typeof assertRequestSize>[0] }).body;
                assertRequestSize(body);
                assertApproved(
                  body,
                  runtime.persistedOperations,
                  runtime.enforcePersistedOperations,
                );
                return { ...ctx, ...(reply ? { reply } : {}) };
              }),
            plugins: [
              persistedOperationsPlugin(runtime.persistedOperations),
              authGuard(runtime.accountInfo, options.verifiedFields),
              complexityLimit(),
              {
                // Cookies set during the request (session, device) go out with the response.
                requestDidStart: () =>
                  Promise.resolve({
                    willSendResponse: ({ contextValue }: { contextValue: GatewayContext }) => {
                      if (contextValue.setCookies.length > 0)
                        contextValue.reply?.header('set-cookie', contextValue.setCookies);
                      if (contextValue.noStore === true)
                        contextValue.reply?.header('cache-control', ['no-store']);
                      return Promise.resolve();
                    },
                  }),
              },
            ],
          };
        },
      }),
    ],
  })
  class AppModule implements OnModuleInit, OnModuleDestroy {
    readonly #runtime: GatewayRuntime;
    readonly #adapter: HttpAdapterHost;
    readonly #config: GatewayConfig;
    readonly #logger: Logger;

    constructor(
      @Inject(GATEWAY_RUNTIME) runtime: GatewayRuntime,
      @Inject(HttpAdapterHost) adapter: HttpAdapterHost,
      @Inject(SERVICE_CONFIG) config: GatewayConfig,
      @Inject(SERVICE_LOGGER) logger: Logger,
    ) {
      this.#runtime = runtime;
      this.#adapter = adapter;
      this.#config = config;
      this.#logger = logger;
    }

    /** The selfie capture upload (ADR-0022) is a plain route beside GraphQL. */
    onModuleInit(): void {
      registerCaptureRoute(this.#adapter.httpAdapter.getInstance<RouteHost>(), {
        runtime: this.#runtime,
        cookieOptions: {
          secure: this.#config.COOKIE_SECURE,
          graphqlPath: this.#config.GRAPHQL_PUBLIC_PATH,
        },
        trustedHops: this.#config.TRUSTED_PROXY_HOPS,
        logger: this.#logger,
      });
    }

    onModuleDestroy(): void {
      this.#runtime.close();
    }
  }
  return AppModule;
}
