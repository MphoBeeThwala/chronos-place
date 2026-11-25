import { readFileSync } from 'node:fs';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { schemaPath } from '@chronos/contracts/graphql';
import type { Logger } from '@chronos/logger';
import { SERVICE_CONFIG, SERVICE_LOGGER } from '@chronos/service-kit';
import { Inject, Module, type OnModuleDestroy, type Type } from '@nestjs/common';
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
import { identityResolvers } from './graphql/identity-resolvers.js';
import { type ResolverMap, rootResolvers } from './graphql/not-available.js';
import { createGatewayRuntime, type GatewayConfig, type GatewayRuntime } from './runtime.js';

export const GATEWAY_RUNTIME = Symbol('GATEWAY_RUNTIME');

/** Fields served today. Others answer NOT_AVAILABLE until their services exist. */
const defaultResolvers = (runtime: GatewayRuntime): ResolverMap => identityResolvers(runtime);

const SDL = readFileSync(schemaPath, 'utf8');

export interface AppModuleOptions {
  /** Tests replace the identity client and add resolvers. */
  runtime?: (config: GatewayConfig, logger: Logger) => GatewayRuntime;
  resolvers?: (runtime: GatewayRuntime) => ResolverMap;
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
              authGuard(runtime.accountState),
              complexityLimit(),
              {
                // Cookies set during the request (session, device) go out with the response.
                requestDidStart: () =>
                  Promise.resolve({
                    willSendResponse: ({ contextValue }: { contextValue: GatewayContext }) => {
                      if (contextValue.setCookies.length > 0)
                        contextValue.reply?.header('set-cookie', contextValue.setCookies);
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
  class AppModule implements OnModuleDestroy {
    readonly #runtime: GatewayRuntime;

    constructor(@Inject(GATEWAY_RUNTIME) runtime: GatewayRuntime) {
      this.#runtime = runtime;
    }

    onModuleDestroy(): void {
      this.#runtime.close();
    }
  }
  return AppModule;
}
