import { createServer } from 'node:net';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger, type LoggerOptions } from '@chronos/logger';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import { createAppModule } from '../../src/app.module.js';
import type { RuntimeOverrides } from '../../src/runtime.js';
import { disclosureConfig } from '../../src/config.js';
import { DISCLOSURE_PACKAGE, DISCLOSURE_PROTO } from '../../src/proto.js';

type Call<Req, Res> = (request: Req) => Observable<Res>;

export interface WireCondition {
  code: string;
  status: number;
}
export interface WireProfile {
  conditions?: WireCondition[];
  freeText?: string;
  note?: string;
}
export interface DisclosureClient {
  upsertHealthProfile: Call<
    { accountId: string; profile?: WireProfile; expectedVersion?: number },
    { version: number }
  >;
  getOwnHealthProfile: Call<
    { accountId: string },
    {
      profile?: {
        profile: WireProfile;
        visibility: number;
        filterOptIn: boolean;
        version: number;
      };
    }
  >;
  listConditionTaxonomy: Call<
    { includeRetired?: boolean },
    { entries?: { code: string; labelEn: string; active: boolean }[] }
  >;
  viewHealthProfile: Call<
    {
      viewerAccountId: string;
      subjectAccountId: string;
      purpose?: number;
      moderation?: { reportId?: string; staffId?: string };
    },
    {
      allowed: boolean;
      profile?: WireProfile & {
        scope: number;
        leaseExpiresAt: unknown;
      };
    }
  >;
  grantDisclosure: Call<Record<string, unknown>, unknown>;
  setVisibility: Call<
    { accountId: string; visibility?: number; filterOptIn?: boolean },
    { visibility: number; filterOptIn: boolean }
  >;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });

const SHARED_WRAPPER = new InMemoryKeyWrapper();

/** The database URL, connecting with the runtime role's real privileges. */
export const asServiceRole = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set('options', '-c role=disclosure_service');
  return u.toString();
};

export interface StartedService {
  client: DisclosureClient;
  stop: () => Promise<void>;
}

/** Starts the real service (gRPC, allow-list logger, no telemetry) with an in-memory KMS. */
export async function startService(
  databaseUrl: string,
  logs?: LoggerOptions['destination'],
  overrides: Omit<RuntimeOverrides, 'keyring'> = {},
): Promise<StartedService> {
  const grpcPort = await freePort();
  // One wrapper for every test service, like one KMS key for every instance in production.
  const wrapper = SHARED_WRAPPER;
  const service: RunningService = await bootstrapService({
    module: createAppModule({
      keyring: (store) => new SubjectKeyring({ wrapper, store, cacheTtlMs: 0 }),
      ...overrides,
    }),
    extraConfig: disclosureConfig,
    grpc: { packageName: DISCLOSURE_PACKAGE, protoPath: DISCLOSURE_PROTO },
    loggerMode: 'allowlist',
    telemetry: false,
    ...(logs
      ? {
          logger: createLogger({
            service: 'disclosure-service',
            mode: 'allowlist',
            level: 'debug',
            destination: logs,
          }),
        }
      : {}),
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'disclosure-service',
      HTTP_PORT: String(await freePort()),
      GRPC_PORT: String(grpcPort),
      SHUTDOWN_DRAIN_MS: '0',
      VAULT_DATABASE_URL: asServiceRole(databaseUrl),
      VAULT_DATA_KEY_ID: 'alias/test-vault',
    },
    onInvalidConfig: 'throw',
    installSignalHandlers: false,
    exit: () => undefined,
  });
  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: DISCLOSURE_PACKAGE,
      protoPath: DISCLOSURE_PROTO,
      url: `127.0.0.1:${String(grpcPort)}`,
    },
  }) as unknown as ClientGrpc & { close: () => void };
  return {
    client: proxy.getService<DisclosureClient>('DisclosureService'),
    stop: async () => {
      proxy.close();
      await service.shutdown('test');
    },
  };
}

export async function grpcError(
  promise: Promise<unknown>,
): Promise<{ code: number | undefined; details: string | undefined }> {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: number; details?: string } | undefined;
  return { code: error?.code, details: error?.details };
}

/** Identity stand-in: active members and which of them are verified. Set `down` to fail. */
export class FakeMembers {
  readonly verified = new Map<string, boolean>();
  down = false;

  verifiedById(ids: readonly string[]): Promise<Map<string, boolean>> {
    if (this.down) return Promise.reject(new Error('identity unreachable'));
    return Promise.resolve(
      new Map(
        ids.flatMap((id) =>
          this.verified.has(id) ? [[id, this.verified.get(id) === true] as const] : [],
        ),
      ),
    );
  }

  close(): void {}
}

/** Matching stand-in: matches and blocks between pairs (either order). */
export class FakeRelationships {
  readonly matches = new Set<string>();
  readonly blocks = new Set<string>();
  static key = (a: string, b: string) => [a, b].sort().join(':');

  between(a: string, b: string) {
    const key = FakeRelationships.key(a, b);
    return Promise.resolve({ blocked: this.blocks.has(key), activeMatch: this.matches.has(key) });
  }
}
