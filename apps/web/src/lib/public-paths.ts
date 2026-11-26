/** Routes that need no session (the middleware lets them through; the idle timeout skips them). */
export const PUBLIC_PATHS = ['/sign-in', '/consent', '/terms', '/privacy', '/account-deleted'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
