'use client';

/**
 * Apollo Client provider for Client Components.
 *
 * The browser only ever calls the same-origin /api/graphql path (rewritten to the gateway in
 * next.config.ts), so the session cookies stay first-party and the CSP keeps connect-src 'self'.
 * Every request names its approved operation by hash, and an expired access cookie is renewed
 * silently (ADR-0021).
 */
import { ApolloLink, HttpLink } from '@apollo/client';
import {
  ApolloClient,
  ApolloNextAppProvider,
  InMemoryCache,
} from '@apollo/experimental-nextjs-app-support';
import { persistedOperationLink, sessionRefreshLink } from '@/lib/apollo-links';
import { refreshSession as refresh } from '@/lib/session';
import { GRAPHQL_PATH } from '@/lib/session-refresh';

function makeClient(): ApolloClient<unknown> {
  return new ApolloClient({
    // Results follow the approved operations' text exactly, which carries no __typename.
    cache: new InMemoryCache({ addTypename: false }),
    link: ApolloLink.from([
      sessionRefreshLink(refresh, () => {
        window.location.assign('/sign-in');
      }),
      persistedOperationLink,
      new HttpLink({
        uri: GRAPHQL_PATH,
        credentials: 'same-origin',
        fetchOptions: { cache: 'no-store' },
      }),
    ]),
  });
}

export function ApolloWrapper({ children }: { children: React.ReactNode }) {
  return <ApolloNextAppProvider makeClient={makeClient}>{children}</ApolloNextAppProvider>;
}
