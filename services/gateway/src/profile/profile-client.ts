import { fileURLToPath } from 'node:url';
import { GrpcServiceClient } from '../grpc/service-client.js';

export const PROFILE_PROTO = fileURLToPath(
  import.meta.resolve('@chronos/contracts/proto/chronos/profile/v1/profile.proto'),
);

/** gRPC client for chronos.profile.v1.ProfileService (ADR-0023). */
export class ProfileClient extends GrpcServiceClient {
  constructor(options: { address: string; timeoutMs?: number }) {
    super({ ...options, protoPath: PROFILE_PROTO, service: 'chronos.profile.v1.ProfileService' });
  }
}
