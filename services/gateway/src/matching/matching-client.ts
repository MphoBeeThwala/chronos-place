import { fileURLToPath } from 'node:url';
import type { ChannelCredentials } from '@grpc/grpc-js';
import { GrpcServiceClient } from '../grpc/service-client.js';

export const MATCHING_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/matching/v1/matching.proto'),
);

/** gRPC client for chronos.matching.v1.MatchingService: likes, matches and blocks (M3.1). Ids only. */
export class MatchingClient extends GrpcServiceClient {
  constructor(options: { address: string; timeoutMs?: number; credentials?: ChannelCredentials }) {
    super({
      ...options,
      protoPath: MATCHING_PROTO,
      service: 'chronos.matching.v1.MatchingService',
    });
  }
}
