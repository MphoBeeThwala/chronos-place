import { OPERATIONS } from '@/graphql/operations.generated';

/**
 * Silent session refresh (ADR-0021, decision c). The 10-minute access cookie is renewed with the
 * refresh cookie, which only the gateway can read. One refresh runs at a time in this tab; a
 * refresh already running on another gateway replica answers REFRESH_IN_PROGRESS, and by the time
 * it has finished the browser holds the new cookies, so the caller just retries.
 */
export type RefreshOutcome = 'refreshed' | 'signed-out';

export const GRAPHQL_PATH = '/api/graphql';
const IN_PROGRESS_WAIT_MS = 500;

interface GraphQLBody {
  errors?: { extensions?: { code?: string } }[];
}

export function createRefreshCoordinator(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<RefreshOutcome> {
  let pending: Promise<RefreshOutcome> | undefined;

  const once = async (): Promise<RefreshOutcome> => {
    const { hash, text } = OPERATIONS.RefreshSession;
    try {
      const response = await fetchFn(GRAPHQL_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: 'RefreshSession',
          query: text,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
      });
      const body = (await response.json()) as GraphQLBody;
      const code = body.errors?.[0]?.extensions?.code;
      if (code === undefined) return 'refreshed';
      if (code === 'REFRESH_IN_PROGRESS') {
        await wait(IN_PROGRESS_WAIT_MS);
        return 'refreshed';
      }
      return 'signed-out';
    } catch {
      return 'signed-out';
    }
  };

  return () => {
    pending ??= once().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Operations that work without a session; their UNAUTHENTICATED errors are final. */
const SESSIONLESS = new Set(['RequestOtp', 'VerifyOtp', 'RefreshSession']);

export function shouldRefresh(
  operationName: string | undefined,
  codes: readonly (string | undefined)[],
) {
  return (
    operationName !== undefined &&
    !SESSIONLESS.has(operationName) &&
    codes.some((code) => code === 'UNAUTHENTICATED')
  );
}
