import { ApolloLink, Observable } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { OPERATIONS } from '@/graphql/operations.generated';
import { shouldRefresh, type RefreshOutcome } from './session-refresh';

/**
 * Names the approved operation by hash (ADR-0021). Outside development the gateway runs the
 * manifest's text for that hash and refuses anything without one.
 */
export const persistedOperationLink = new ApolloLink((operation, forward) => {
  const entry = (OPERATIONS as Record<string, { hash: string } | undefined>)[
    operation.operationName
  ];
  if (entry) operation.extensions['persistedQuery'] = { version: 1, sha256Hash: entry.hash };
  return forward(operation);
});

/**
 * Retries an operation once after a silent refresh when the access cookie has expired. If the
 * session cannot be refreshed, the member is sent to sign in.
 */
export function sessionRefreshLink(
  refresh: () => Promise<RefreshOutcome>,
  onSignedOut: () => void,
): ApolloLink {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the replacement (`error`) arrives with Apollo Client 4; graphQLErrors is the documented 3.x API
  return onError(({ graphQLErrors, operation, forward }) => {
    const codes = (graphQLErrors ?? []).map((e) => e.extensions?.['code'] as string | undefined);
    if (operation.getContext()['retriedAfterRefresh'] === true) return undefined;
    if (!shouldRefresh(operation.operationName, codes)) return undefined;
    return new Observable((observer) => {
      void refresh().then((outcome) => {
        if (outcome === 'signed-out') {
          onSignedOut();
          observer.complete();
          return;
        }
        operation.setContext({ retriedAfterRefresh: true });
        forward(operation).subscribe(observer);
      });
    });
  });
}
