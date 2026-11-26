import type { ChannelCredentials } from '@grpc/grpc-js';
import { GrpcServiceClient } from '../grpc/service-client.js';

/** google.protobuf.Timestamp as proto-loader returns it (longs as strings). */
export interface WireTimestamp {
  seconds: string;
  nanos: number;
}

/**
 * A google.protobuf.Timestamp as a Date. The protobuf runtime can be configured (by the contracts'
 * generated code) to hand Timestamps over as Date objects; plain {seconds, nanos} is handled too.
 */
export const toDate = (t: Date | WireTimestamp | null | undefined): Date => {
  if (t instanceof Date) return t;
  return new Date(Number(t?.seconds ?? 0) * 1000 + Math.floor((t?.nanos ?? 0) / 1_000_000));
};

/** gRPC client for chronos.identity.v1.IdentityService. */
export class IdentityClient extends GrpcServiceClient {
  constructor(options: {
    address: string;
    protoPath: string;
    timeoutMs?: number;
    credentials?: ChannelCredentials;
  }) {
    super({ ...options, service: 'chronos.identity.v1.IdentityService' });
  }
}
