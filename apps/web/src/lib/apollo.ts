/**
 * Apollo Client for Server Components (request-scoped, so no cache is shared between members).
 * Client Components use ApolloWrapper (components/layout).
 *
 * Health data never goes into cache keys, local state, logs or analytics events.
 */
import {
  ApolloClient,
  InMemoryCache,
  registerApolloClient,
} from '@apollo/experimental-nextjs-app-support';
import { HttpLink } from '@apollo/client';
import { config } from './config';

export const { getClient } = registerApolloClient(
  () =>
    new ApolloClient({
      cache: new InMemoryCache(),
      link: new HttpLink({
        uri: config.GATEWAY_URL,
        // Server-side fetches must never be cached by Next.js: responses can carry personal data.
        fetchOptions: { cache: 'no-store' },
      }),
      defaultOptions: {
        query: { errorPolicy: 'none' },
        mutate: { errorPolicy: 'none' },
      },
    }),
);
