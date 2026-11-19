/**
 * Apollo Client setup for Next.js App Router.
 * Uses @apollo/experimental-nextjs-app-support for RSC + Client Component support.
 *
 * Server Components use `getClient()` (request-scoped, no cache leaks).
 * Client Components use `ApolloWrapper` (defined in components/layout).
 *
 * Headers: the access token is attached in the auth link.
 * We never send health data in cache keys, local state, or analytics events.
 */
import { ApolloClient, HttpLink, InMemoryCache, from } from '@apollo/client';
import { registerApolloClient } from '@apollo/experimental-nextjs-app-support/rsc';
import { config } from './config.js';

const httpLink = new HttpLink({
  uri: config.GATEWAY_URL,
  // Credentials: include cookies so the session cookie travels with requests.
  credentials: 'include',
});

export const { getClient } = registerApolloClient(
  () =>
    new ApolloClient({
      cache: new InMemoryCache(),
      link: from([httpLink]),
      // Never log responses — they may contain health data.
      defaultOptions: {
        query: { errorPolicy: 'none' },
        mutate: { errorPolicy: 'none' },
      },
    }),
);
