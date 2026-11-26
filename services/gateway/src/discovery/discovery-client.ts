import { fileURLToPath } from 'node:url';
import type { ChannelCredentials } from '@grpc/grpc-js';
import { GrpcServiceClient } from '../grpc/service-client.js';

export const DISCOVERY_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/discovery/v1/discovery.proto'),
);

/** gRPC client for chronos.discovery.v1.DiscoveryService: the feed (M3.2). Ids only. */
export class DiscoveryClient extends GrpcServiceClient {
  constructor(options: { address: string; timeoutMs?: number; credentials?: ChannelCredentials }) {
    super({
      ...options,
      protoPath: DISCOVERY_PROTO,
      service: 'chronos.discovery.v1.DiscoveryService',
    });
  }
}
