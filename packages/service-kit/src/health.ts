import { Controller, Get, Inject, Res } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ReadinessRegistry, type CheckState } from './readiness.js';

interface Reply {
  status: (code: number) => unknown;
}

/** HTTP probes. Liveness says the process is up; readiness says it can take traffic. */
@Controller()
export class HealthHttpController {
  readonly #readiness: ReadinessRegistry;

  constructor(@Inject(ReadinessRegistry) readiness: ReadinessRegistry) {
    this.#readiness = readiness;
  }

  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<{ status: 'ok' | 'unavailable'; checks: Record<string, CheckState> }> {
    const result = await this.#readiness.check();
    if (!result.ready) reply.status(503);
    return { status: result.ready ? 'ok' : 'unavailable', checks: result.checks };
  }
}

const SERVING = 1;
const NOT_SERVING = 2;

/** Standard grpc.health.v1 service, for Kubernetes gRPC probes. */
@Controller()
export class HealthGrpcController {
  readonly #readiness: ReadinessRegistry;

  constructor(@Inject(ReadinessRegistry) readiness: ReadinessRegistry) {
    this.#readiness = readiness;
  }

  @GrpcMethod('Health', 'Check')
  async check(): Promise<{ status: number }> {
    const result = await this.#readiness.check();
    return { status: result.ready ? SERVING : NOT_SERVING };
  }
}
