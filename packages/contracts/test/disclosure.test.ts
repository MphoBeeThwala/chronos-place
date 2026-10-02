import { createServer } from 'node:net';
import path from 'node:path';
import 'reflect-metadata';
import { Controller, Module, type INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as disclosure from '../gen/chronos/disclosure/v1/disclosure.js';
import {
  ConditionStatus,
  DisclosureServiceControllerMethods,
  FilterOutcome,
  GrantScope,
  Purpose,
  Visibility,
  type DisclosureServiceClient,
  type DisclosureServiceController,
  type ViewHealthProfileRequest,
  type ViewHealthProfileResponse,
} from '../gen/chronos/disclosure/v1/disclosure.js';

const MARKER = 'SYNTHETIC-MARKER-7f3a9c';
const LEASE = new Date('2026-10-02T12:00:00.000Z');

type Message = {
  encode: (m: never) => { finish: () => Uint8Array };
  decode: (b: Uint8Array) => unknown;
  fromPartial: (p: object) => never;
};

const messages = (Object.entries(disclosure) as [string, unknown][]).filter(
  ([, value]) =>
    typeof value === 'object' && value !== null && 'fromPartial' in value && 'encode' in value,
) as unknown as [string, Message][];

describe('protobuf messages', () => {
  it('generates every message in the proto', () => {
    expect(messages.map(([name]) => name).sort()).toEqual(
      [
        'AccessRecord',
        'Condition',
        'EraseSubjectRequest',
        'EraseSubjectResponse',
        'ExportSubjectRequest',
        'ExportSubjectResponse',
        'FilterEligibleSubjectsRequest',
        'FilterEligibleSubjectsResponse',
        'GetFilterPreferencesRequest',
        'GetFilterPreferencesResponse',
        'GetOwnHealthProfileRequest',
        'GetOwnHealthProfileResponse',
        'GrantDisclosureRequest',
        'GrantDisclosureResponse',
        'GrantRecord',
        'HealthProfile',
        'HealthProfileView',
        'HealthViewer',
        'ListConditionTaxonomyRequest',
        'ListConditionTaxonomyResponse',
        'ListHealthViewersRequest',
        'ListHealthViewersResponse',
        'ModerationContext',
        'OwnHealthProfile',
        'RevokeDisclosureRequest',
        'RevokeDisclosureResponse',
        'SetFilterPreferencesRequest',
        'SetFilterPreferencesResponse',
        'SetVisibilityRequest',
        'SetVisibilityResponse',
        'TaxonomyEntry',
        'UpsertHealthProfileRequest',
        'UpsertHealthProfileResponse',
        'ViewHealthProfileRequest',
        'ViewHealthProfileResponse',
      ].sort(),
    );
  });

  it.each(messages)('%s survives an encode/decode round trip (empty)', (_name, message) => {
    const value = message.fromPartial({});
    expect(message.decode(message.encode(value).finish())).toEqual(value);
  });

  it('round-trips a populated profile view with enums, repeated fields and dates', () => {
    const view = disclosure.HealthProfileView.fromPartial({
      conditions: [
        { code: 'synthetic_condition', status: ConditionStatus.CONDITION_STATUS_IN_REMISSION },
      ],
      freeText: `${MARKER} free text ✓`,
      note: MARKER,
      scope: GrantScope.GRANT_SCOPE_CONDITIONS_ONLY,
      leaseExpiresAt: LEASE,
    });
    const decoded = disclosure.HealthProfileView.decode(
      disclosure.HealthProfileView.encode(view).finish(),
    );
    expect(decoded).toEqual(view);
    expect(decoded.leaseExpiresAt).toEqual(LEASE);
  });

  it('keeps the unspecified enum value at zero, so unset never means a real choice', () => {
    expect(Visibility.VISIBILITY_UNSPECIFIED).toBe(0);
    expect(Visibility.VISIBILITY_HIDDEN).toBe(1);
    expect(GrantScope.GRANT_SCOPE_UNSPECIFIED).toBe(0);
    expect(Purpose.PURPOSE_UNSPECIFIED).toBe(0);
    expect(FilterOutcome.FILTER_OUTCOME_UNSPECIFIED).toBe(0);
  });
});

/** An in-memory stand-in for the Disclosure Service, implementing the generated controller interface. */
class FakeDisclosure implements DisclosureServiceController {
  view(request: ViewHealthProfileRequest): ViewHealthProfileResponse {
    if (
      request.viewerAccountId === 'viewer-ok' &&
      request.purpose === Purpose.PURPOSE_PROFILE_VIEW
    ) {
      return {
        allowed: true,
        profile: {
          conditions: [
            { code: 'synthetic_condition', status: ConditionStatus.CONDITION_STATUS_LIVING_WITH },
          ],
          freeText: MARKER,
          note: '',
          scope: GrantScope.GRANT_SCOPE_FULL,
          leaseExpiresAt: LEASE,
        },
      };
    }
    return { allowed: false, profile: undefined };
  }

  // gRPC handlers must be prototype methods: the generated decorator binds them by name.
  viewHealthProfile(request: ViewHealthProfileRequest): ViewHealthProfileResponse {
    return this.view(request);
  }

  upsertHealthProfile() {
    return { version: 2 };
  }

  getOwnHealthProfile() {
    return { profile: undefined };
  }

  setVisibility() {
    return { visibility: Visibility.VISIBILITY_HIDDEN, filterOptIn: false };
  }

  grantDisclosure() {
    return { grantId: 'grant-1', grantedAt: LEASE };
  }

  revokeDisclosure() {
    return { revoked: true };
  }

  listHealthViewers() {
    return { viewers: [], nextPageToken: '' };
  }

  listConditionTaxonomy() {
    return { entries: [{ code: 'synthetic_condition', labelEn: 'Synthetic condition' }] };
  }

  setFilterPreferences() {
    return {};
  }

  getFilterPreferences() {
    return { wantedConditionCodes: ['synthetic_condition'] };
  }

  filterEligibleSubjects() {
    return {
      outcome: FilterOutcome.FILTER_OUTCOME_BELOW_THRESHOLD,
      eligibleAccountIds: [] as string[],
    };
  }

  exportSubject() {
    return { profile: undefined, wantedConditionCodes: [] as string[], grants: [], accesses: [] };
  }

  eraseSubject() {
    return { completed: true };
  }
}

Controller()(FakeDisclosure);
DisclosureServiceControllerMethods()(FakeDisclosure);

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are empty classes configured by decorator calls
class FakeModule {}
Module({ controllers: [FakeDisclosure] })(FakeModule);

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

describe('over real gRPC with NestJS', () => {
  let app: INestMicroservice;
  let client: DisclosureServiceClient;
  let proxy: ClientGrpc & { close: () => void };

  beforeAll(async () => {
    const url = `127.0.0.1:${String(await freePort())}`;
    const options = {
      package: 'chronos.disclosure.v1',
      protoPath: path.resolve(
        import.meta.dirname,
        '../proto/chronos/disclosure/v1/disclosure.proto',
      ),
      url,
    };
    app = await NestFactory.createMicroservice(FakeModule, {
      transport: Transport.GRPC,
      options,
      logger: false,
    });
    await app.listen();
    proxy = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options,
    });
    client = proxy.getService<DisclosureServiceClient>('DisclosureService');
  });

  afterAll(async () => {
    proxy.close();
    await app.close();
  });

  const call = firstValueFrom;

  it('returns an allowed view with enums, text and a lease date', async () => {
    const response = await call(
      client.viewHealthProfile({
        viewerAccountId: 'viewer-ok',
        subjectAccountId: 'subject',
        purpose: Purpose.PURPOSE_PROFILE_VIEW,
        moderation: undefined,
      }),
    );
    expect(response.allowed).toBe(true);
    expect(response.profile?.conditions[0]?.status).toBe(
      ConditionStatus.CONDITION_STATUS_LIVING_WITH,
    );
    expect(response.profile?.freeText).toBe(MARKER);
    expect(response.profile?.leaseExpiresAt).toEqual(LEASE);
  });

  it('returns a denial with no profile and nothing that says why', async () => {
    const response = await call(
      client.viewHealthProfile({
        viewerAccountId: 'viewer-denied',
        subjectAccountId: 'subject',
        purpose: Purpose.PURPOSE_PROFILE_VIEW,
        moderation: undefined,
      }),
    );
    expect(response.allowed).toBe(false);
    expect(response.profile).toBeUndefined();
    expect(Object.keys(response)).toEqual(['allowed']);
  });

  it('serves the other methods through the same generated types', async () => {
    expect(
      (await call(client.filterEligibleSubjects({ viewerAccountId: 'v', candidateAccountIds: [] })))
        .outcome,
    ).toBe(FilterOutcome.FILTER_OUTCOME_BELOW_THRESHOLD);
    expect(
      (await call(client.getFilterPreferences({ accountId: 'a' }))).wantedConditionCodes,
    ).toEqual(['synthetic_condition']);
    expect((await call(client.listConditionTaxonomy({}))).entries[0]?.labelEn).toBe(
      'Synthetic condition',
    );
    expect(
      (
        await call(
          client.grantDisclosure({
            subjectAccountId: 'a',
            viewerAccountId: 'b',
            scope: GrantScope.GRANT_SCOPE_FULL,
          }),
        )
      ).grantedAt,
    ).toEqual(LEASE);
    expect(
      (await call(client.eraseSubject({ subjectAccountId: 'a', requestId: 'r' }))).completed,
    ).toBe(true);
  });
});
