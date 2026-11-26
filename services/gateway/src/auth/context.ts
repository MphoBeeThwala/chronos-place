import { randomBytes } from 'node:crypto';
import { verifyAccessToken } from '@chronos/session-tokens';
import {
  ACCESS_COOKIE,
  type CookieOptions,
  DEVICE_COOKIE,
  deviceCookie,
  parseCookies,
  REFRESH_COOKIE,
} from './cookies.js';
import type { SigningKeyCache } from './signing-keys.js';

export interface Viewer {
  accountId: string;
  sessionId: string;
}

/** Per-request state shared by the guard and the resolvers. */
export interface GatewayContext {
  /** Set when the request carries a valid access token. */
  viewer?: Viewer;
  deviceId: string;
  ip: string;
  /** The refresh cookie, for refreshSession only. */
  refreshToken?: string;
  /** Set-Cookie values to send with the response. */
  setCookies: string[];
  /** Set by a resolver whose answer must never be cached (sends Cache-Control: no-store). */
  noStore?: boolean;
  cookieOptions: CookieOptions;
  /** The HTTP reply, so Set-Cookie headers can be added after the operation runs. */
  reply?: { header: (name: string, value: string[]) => unknown };
}

const DEVICE_FORMAT = /^[A-Za-z0-9_-]{22}$/;

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

const header = (req: RequestLike, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * The client's IP. Only the last `trustedHops` X-Forwarded-For entries were added by proxies we run,
 * so the entry just before them is the client; anything earlier could be forged.
 */
export function clientIp(req: RequestLike, trustedHops: number): string {
  const socket = req.socket?.remoteAddress ?? req.ip ?? '0.0.0.0';
  if (trustedHops === 0) return socket;
  const forwarded = (header(req, 'x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return forwarded[forwarded.length - trustedHops] ?? socket;
}

export async function buildContext(
  req: RequestLike,
  options: { keys: SigningKeyCache; cookieOptions: CookieOptions; trustedHops: number; now?: Date },
): Promise<GatewayContext> {
  const cookies = parseCookies(header(req, 'cookie'));
  const setCookies: string[] = [];

  let deviceId = cookies.get(DEVICE_COOKIE) ?? '';
  if (!DEVICE_FORMAT.test(deviceId)) {
    deviceId = randomBytes(16).toString('base64url');
    setCookies.push(deviceCookie(deviceId, options.cookieOptions));
  }

  let viewer: Viewer | undefined;
  const access = cookies.get(ACCESS_COOKIE);
  if (access) {
    try {
      const kid = (
        JSON.parse(Buffer.from(access.split('.')[0] ?? '', 'base64url').toString()) as {
          kid?: unknown;
        }
      ).kid;
      if (typeof kid === 'string') await options.keys.resolve(kid);
      const claims = verifyAccessToken(
        access,
        (k) => options.keys.get(k),
        options.now ?? new Date(),
      );
      viewer = { accountId: claims.sub, sessionId: claims.sid };
    } catch {
      // An invalid or expired token is the same as none; the guard decides what that allows.
    }
  }

  const refreshToken = cookies.get(REFRESH_COOKIE);
  return {
    ...(viewer ? { viewer } : {}),
    deviceId,
    ip: clientIp(req, options.trustedHops),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    setCookies,
    cookieOptions: options.cookieOptions,
  };
}
