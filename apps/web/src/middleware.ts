/**
 * Next.js middleware: auth guard.
 *
 * The session token lives in an httpOnly cookie set by the gateway. Here we only check that the
 * cookie is present; the gateway validates it on every request. Unauthenticated visitors are
 * sent to /sign-in. The original path is not put in the query string: a path
 * could say something about the member (CLAUDE.md rule 3: nothing implying health in URLs).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { DEVELOPMENT, STORAGE_ORIGIN } from '@/lib/build-constants';
import { buildCsp, NONCE_HEADER, newNonce } from '@/lib/csp';
import { isPublicPath } from '@/lib/public-paths';

const SESSION_COOKIE = 'chronos_session';

export function middleware(request: NextRequest): NextResponse {
  if (!request.cookies.has(SESSION_COOKIE) && !isPublicPath(request.nextUrl.pathname)) {
    const signInUrl = request.nextUrl.clone();
    signInUrl.pathname = '/sign-in';
    signInUrl.search = '';
    return NextResponse.redirect(signInUrl);
  }

  // A fresh nonce per request (ADR-0017, TASKS M1.9). Next.js reads the policy from the request
  // headers and stamps the nonce on its own scripts; the root layout stamps the theme script.
  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    storage: STORAGE_ORIGIN,
    development: DEVELOPMENT,
  });
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  // Every route except Next.js internals, the gateway rewrites and static files.
  matcher: [
    '/((?!_next|api/graphql|api/verification|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)',
  ],
};
