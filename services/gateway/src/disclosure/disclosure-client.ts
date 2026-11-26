import { fileURLToPath } from 'node:url';
import type { ChannelCredentials } from '@grpc/grpc-js';
import { GrpcServiceClient } from '../grpc/service-client.js';

export const DISCLOSURE_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/disclosure/v1/disclosure.proto'),
);

/**
 * gRPC client for chronos.disclosure.v1.DisclosureService, the only door to health data (CLAUDE.md
 * rule 2). The gateway passes health data through to the member and never stores or logs it.
 */
export class DisclosureClient extends GrpcServiceClient {
  constructor(options: { address: string; timeoutMs?: number; credentials?: ChannelCredentials }) {
    super({
      ...options,
      protoPath: DISCLOSURE_PROTO,
      service: 'chronos.disclosure.v1.DisclosureService',
    });
  }
}
