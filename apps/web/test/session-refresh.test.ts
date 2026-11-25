import { ApolloLink, execute, gql, Observable, type FetchResult } from '@apollo/client';
import { describe, expect, it, vi } from 'vitest';
import { persistedOperationLink, sessionRefreshLink } from '@/lib/apollo-links';
import { createRefreshCoordinator, shouldRefresh } from '@/lib/session-refresh';
import { OPERATIONS } from '@/graphql/operations.generated';

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

describe('refresh coordinator', () => {
  it('sends the approved RefreshSession operation once for many callers', async () => {
    const fetchFn = vi.fn(() => json({ data: { refreshSession: { expiresAt: 'x' } } }));
    const refresh = createRefreshCoordinator(fetchFn);
    expect(await Promise.all([refresh(), refresh(), refresh()])).toEqual([
      'refreshed',
      'refreshed',
      'refreshed',
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/graphql');
    expect(JSON.parse(init.body as string)).toMatchObject({
      operationName: 'RefreshSession',
      extensions: { persistedQuery: { sha256Hash: OPERATIONS.RefreshSession.hash } },
    });
  });

  it('waits and reports success when another replica is already refreshing', async () => {
    const wait = vi.fn(() => Promise.resolve());
    const refresh = createRefreshCoordinator(
      () =>
        json({
          errors: [{ extensions: { code: 'REFRESH_IN_PROGRESS' } }],
        }),
      wait,
    );
    expect(await refresh()).toBe('refreshed');
    expect(wait).toHaveBeenCalledWith(500);
  });

  it('reports signed out when the session cannot be refreshed or the network fails', async () => {
    const refused = createRefreshCoordinator(() =>
      json({ errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }),
    );
    expect(await refused()).toBe('signed-out');
    const offline = createRefreshCoordinator(() => Promise.reject(new Error('offline')));
    expect(await offline()).toBe('signed-out');
  });

  it('refreshes only for session operations that were refused as unauthenticated', () => {
    expect(shouldRefresh('Account', ['UNAUTHENTICATED'])).toBe(true);
    expect(shouldRefresh('VerifyOtp', ['UNAUTHENTICATED'])).toBe(false);
    expect(shouldRefresh('RefreshSession', ['UNAUTHENTICATED'])).toBe(false);
    expect(shouldRefresh('Account', ['FORBIDDEN'])).toBe(false);
  });
});

const ACCOUNT = gql(OPERATIONS.Account.text);

function run(link: ApolloLink): Promise<FetchResult[]> {
  return new Promise((resolve, reject) => {
    const results: FetchResult[] = [];
    execute(link, { query: ACCOUNT }).subscribe({
      next: (r) => results.push(r),
      error: reject,
      complete: () => {
        resolve(results);
      },
    });
  });
}

describe('links', () => {
  it('names the approved operation by hash', async () => {
    let seen: unknown;
    const terminal = new ApolloLink((op) => {
      seen = op.extensions['persistedQuery'];
      return Observable.of({ data: { account: null } });
    });
    await run(ApolloLink.from([persistedOperationLink, terminal]));
    expect(seen).toEqual({ version: 1, sha256Hash: OPERATIONS.Account.hash });
  });

  it('retries once after a silent refresh', async () => {
    let calls = 0;
    const terminal = new ApolloLink(() => {
      calls += 1;
      return Observable.of(
        calls === 1
          ? {
              errors: [
                { message: 'Sign in to continue.', extensions: { code: 'UNAUTHENTICATED' } },
              ],
            }
          : { data: { account: { id: 'a', status: 'ACTIVE' } } },
      );
    });
    const refresh = vi.fn(() => Promise.resolve('refreshed' as const));
    const results = await run(
      ApolloLink.from([sessionRefreshLink(refresh, () => undefined), terminal]),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(results.at(-1)?.data).toEqual({ account: { id: 'a', status: 'ACTIVE' } });
  });

  it('sends the member to sign in when the refresh fails, without looping', async () => {
    let calls = 0;
    const terminal = new ApolloLink(() => {
      calls += 1;
      return Observable.of({
        errors: [{ message: 'Sign in to continue.', extensions: { code: 'UNAUTHENTICATED' } }],
      });
    });
    const signedOut = vi.fn();
    await run(
      ApolloLink.from([
        sessionRefreshLink(() => Promise.resolve('signed-out'), signedOut),
        terminal,
      ]),
    );
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
  });
});
