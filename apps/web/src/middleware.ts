/**
 * Next.js middleware.
 * Responsibilities:
 *   1. next-intl locale routing (adds locale prefix to URLs where needed).
 *   2. Auth guard: unauthenticated users are redirected to /sign-in.
 *
 * The session token lives in a httpOnly cookie set by the gateway.
 * We check for the cookie's presence here (the gateway validates the JWT).
 */
import { type NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing.js';

const intlMiddleware = createMiddleware(routing);

/** Routes that do NOT require authentication. */
const PUBLIC_PATHS = [
  '/sign-in',
  '/consent',
  '/api/health',
  // Static assets handled by Next.js directly.
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p) || pathname === p);
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Strip locale prefix before path checks.
  const stripped = pathname.replace(/^\/(en|zu|xh|af|st)/, '') || '/';

  // Auth guard: redirect to sign-in if no session cookie.
  const hasSession = request.cookies.has('chronos_session');
  if (!hasSession && !isPublicPath(stripped)) {
    const signInUrl = request.nextUrl.clone();
    signInUrl.pathname = '/sign-in';
    signInUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(signInUrl);
  }

  return intlMiddleware(request);
}

export const config = {
  // Run on all routes except Next.js internals and static files.
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)'],
};
