'use client';

/**
 * Apollo Client provider for Client Components.
 * Server Components use getClient() from lib/apollo directly.
 *
 * The browser only ever calls the same-origin /api/graphql path (rewritten to the gateway in
 * next.config.ts), so the session cookie stays first-party and the CSP keeps connect-src 'self'.
 */
import { HttpLink } from '@apollo/client';
import {
  ApolloClient,
  ApolloNextAppProvider,
  InMemoryCache,
} from '@apollo/experimental-nextjs-app-support';

const GRAPHQL_PATH = '/api/graphql';

function makeClient(): ApolloClient<unknown> {
  return new ApolloClient({
    cache: new InMemoryCache(),
    link: new HttpLink({
      uri: GRAPHQL_PATH,
      credentials: 'same-origin',
      fetchOptions: { cache: 'no-store' },
    }),
  });
}

export function ApolloWrapper({ children }: { children: React.ReactNode }) {
  return <ApolloNextAppProvider makeClient={makeClient}>{children}</ApolloNextAppProvider>;
}
