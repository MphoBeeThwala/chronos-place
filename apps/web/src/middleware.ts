/**
 * Next.js middleware: auth guard.
 *
 * The session token lives in an httpOnly cookie set by the gateway. Here we only check that the
 * cookie is present; the gateway validates it on every request. Unauthenticated visitors are
 * sent to /sign-in. The original path is not put in the query string: paths such as /health
 * can say something about the member (CLAUDE.md rule 3: nothing implying health in URLs).
 */
import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'chronos_session';

/** Routes that do not require a session. */
const PUBLIC_PATHS = ['/sign-in', '/consent', '/terms', '/privacy', '/account-deleted'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(request: NextRequest): NextResponse {
  if (!request.cookies.has(SESSION_COOKIE) && !isPublicPath(request.nextUrl.pathname)) {
    const signInUrl = request.nextUrl.clone();
    signInUrl.pathname = '/sign-in';
    signInUrl.search = '';
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Every route except Next.js internals, the gateway rewrites and static files.
  matcher: [
    '/((?!_next|api/graphql|api/verification|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)',
  ],
};
