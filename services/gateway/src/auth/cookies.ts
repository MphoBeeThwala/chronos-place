/**
 * Session cookies (ADR-0017, ADR-0018). Tokens never reach browser JavaScript: every cookie is
 * httpOnly and SameSite=Strict. The refresh token is sent only to the GraphQL path.
 */
export const ACCESS_COOKIE = 'chronos_access';
export const REFRESH_COOKIE = 'chronos_refresh';
export const DEVICE_COOKIE = 'chronos_device';
/** Presence-only marker the web app's middleware checks to route signed-in members; holds no token. */
export const SESSION_MARKER_COOKIE = 'chronos_session';

export const DEVICE_MAX_AGE_SECONDS = 2 * 365 * 24 * 60 * 60;

export interface CookieOptions {
  secure: boolean;
  graphqlPath: string;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '' && !cookies.has(name)) {
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        // Malformed value: ignore the cookie.
      }
    }
  }
  return cookies;
}

function serialize(
  name: string,
  value: string,
  options: CookieOptions,
  attributes: { path: string; maxAgeSeconds: number },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${attributes.path}`,
    `Max-Age=${String(Math.max(0, Math.floor(attributes.maxAgeSeconds)))}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export interface SessionCookieValues {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** Set-Cookie values that start or renew a session. */
export function sessionCookies(
  tokens: SessionCookieValues,
  options: CookieOptions,
  now: Date = new Date(),
): string[] {
  const seconds = (d: Date) => (d.getTime() - now.getTime()) / 1000;
  return [
    serialize(ACCESS_COOKIE, tokens.accessToken, options, {
      path: '/',
      maxAgeSeconds: seconds(tokens.accessExpiresAt),
    }),
    serialize(REFRESH_COOKIE, tokens.refreshToken, options, {
      path: options.graphqlPath,
      maxAgeSeconds: seconds(tokens.refreshExpiresAt),
    }),
    serialize(SESSION_MARKER_COOKIE, '1', options, {
      path: '/',
      maxAgeSeconds: seconds(tokens.refreshExpiresAt),
    }),
  ];
}

/** Set-Cookie values that end a session on this device. */
export function clearSessionCookies(options: CookieOptions): string[] {
  return [
    serialize(ACCESS_COOKIE, '', options, { path: '/', maxAgeSeconds: 0 }),
    serialize(REFRESH_COOKIE, '', options, { path: options.graphqlPath, maxAgeSeconds: 0 }),
    serialize(SESSION_MARKER_COOKIE, '', options, { path: '/', maxAgeSeconds: 0 }),
  ];
}

export function deviceCookie(deviceId: string, options: CookieOptions): string {
  return serialize(DEVICE_COOKIE, deviceId, options, {
    path: '/',
    maxAgeSeconds: DEVICE_MAX_AGE_SECONDS,
  });
}
