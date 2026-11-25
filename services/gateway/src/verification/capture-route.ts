import type { Logger } from '@chronos/logger';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import { buildContext, type RequestLike } from '../auth/context.js';
import type { CookieOptions } from '../auth/cookies.js';
import { fromGrpc } from '../identity/errors.js';
import {
  type VerificationView,
  verificationView,
  type WireVerification,
} from '../graphql/verification.js';
import type { GatewayRuntime } from '../runtime.js';

/** Where the web app posts a capture (through its same-origin /api rewrite, ADR-0017). */
export const CAPTURE_PATH = '/verification/capture';
/** Images in total, decoded. Matches identity's limit. */
export const MAX_CAPTURE_BYTES = 3 * 1024 * 1024;
export const MAX_FRAMES = 12;
/** Base64 is 4/3 of the bytes; leave room for the JSON around it. */
export const CAPTURE_BODY_LIMIT = Math.ceil((MAX_CAPTURE_BYTES * 4) / 3) + 64 * 1024;
/** Identity hands the capture to the vendor before answering. */
const SUBMIT_TIMEOUT_MS = 20_000;

// A JPEG as the capture component produces it: base64, optionally as a data URL.
const image = z
  .string()
  .max(CAPTURE_BODY_LIMIT)
  .transform((v) => v.replace(/^data:image\/jpeg;base64,/, ''))
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v));
const body = z.object({ selfie: image, frames: z.array(image).min(1).max(MAX_FRAMES) });

interface Problem {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

/** The parts of Fastify the route uses (the gateway reaches Fastify only through Nest). */
export interface ReplyLike {
  status(code: number): ReplyLike;
  header(name: string, value: string | string[]): ReplyLike;
  send(payload: unknown): unknown;
}
export interface RouteHost {
  post(
    path: string,
    options: { bodyLimit: number },
    handler: (request: RequestLike & { body?: unknown }, reply: ReplyLike) => Promise<unknown>,
  ): unknown;
}

type Outcome = { problem: Problem } | { ok: VerificationView };

const HTTP_STATUS: Record<string, number> = {
  BAD_USER_INPUT: 400,
  UNAUTHENTICATED: 401,
  FAILED_PRECONDITION: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

const problem = (status: number, code: string, message: string): Outcome => ({
  problem: { status, code, message },
});

function fromError(error: unknown): Problem {
  const graphql = error instanceof GraphQLError ? error : fromGrpc(error);
  const raw = graphql.extensions['code'];
  const code = typeof raw === 'string' ? raw : 'INTERNAL_SERVER_ERROR';
  const retry = graphql.extensions['retryAfterSeconds'];
  return {
    status: HTTP_STATUS[code] ?? 500,
    code,
    // fromGrpc passes through only identity's fixed messages; anything else is generic.
    message: HTTP_STATUS[code] === undefined ? 'Something went wrong.' : graphql.message,
    ...(typeof retry === 'number' ? { retryAfterSeconds: retry } : {}),
  };
}

export interface CaptureRouteDeps {
  runtime: GatewayRuntime;
  cookieOptions: CookieOptions;
  trustedHops: number;
  logger: Logger;
}

/**
 * POST /verification/capture (ADR-0022 decision 4). Takes one selfie capture from a signed-in,
 * onboarded member and passes it to identity. Not GraphQL: GraphQL variables are capped at 16 KB.
 * - JSON only. A cross-site page cannot send it without a CORS preflight, which the gateway never
 *   allows, and the session cookie is SameSite=Strict.
 * - The same per-IP and per-account rate limits as GraphQL apply; identity adds the attempt limits.
 * - Images are never logged, and errors carry fixed messages only.
 */
export function registerCaptureRoute(host: RouteHost, deps: CaptureRouteDeps): void {
  const { runtime } = deps;

  const handle = async (
    request: RequestLike & { body?: unknown },
    reply: ReplyLike,
  ): Promise<Outcome> => {
    const ctx = await buildContext(request, {
      keys: runtime.keys,
      cookieOptions: deps.cookieOptions,
      trustedHops: deps.trustedHops,
    });
    if (ctx.setCookies.length > 0) reply.header('set-cookie', ctx.setCookies);
    await runtime.rateLimiter.check(ctx.ip, ctx.viewer?.accountId);
    const { viewer } = ctx;
    if (!viewer) return problem(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const { state } = await runtime.accountInfo(viewer.accountId);
    if (state === 'unavailable') return problem(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (state !== 'active') return problem(403, 'FORBIDDEN', 'Finish signing up first.');

    const type = request.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json\b/i.test(type)) {
      return problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the photos as JSON.');
    }
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return problem(400, 'BAD_USER_INPUT', 'The photos could not be read.');
    const selfie = Buffer.from(parsed.data.selfie, 'base64');
    const frames = parsed.data.frames.map((f) => Buffer.from(f, 'base64'));
    const total = frames.reduce((n, f) => n + f.length, selfie.length);
    if (total > MAX_CAPTURE_BYTES)
      return problem(413, 'PAYLOAD_TOO_LARGE', 'The photos are too large.');

    const result = await runtime.identity.call<{ verification: WireVerification }>(
      'submitLiveness',
      { accountId: viewer.accountId, capture: { selfieJpeg: selfie, livenessFramesJpeg: frames } },
      undefined,
      { timeoutMs: SUBMIT_TIMEOUT_MS },
    );
    return { ok: verificationView(result.verification) };
  };

  host.post(CAPTURE_PATH, { bodyLimit: CAPTURE_BODY_LIMIT }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    let outcome: Outcome;
    try {
      outcome = await handle(request, reply);
    } catch (error) {
      const p = fromError(error);
      if (p.status === 500) deps.logger.error({ err: error }, 'capture upload failed');
      outcome = { problem: p };
    }
    if ('ok' in outcome) return reply.status(200).send(outcome.ok);
    const { status, ...error } = outcome.problem;
    if (error.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(error.retryAfterSeconds));
    }
    return reply.status(status).send({ error });
  });
}
