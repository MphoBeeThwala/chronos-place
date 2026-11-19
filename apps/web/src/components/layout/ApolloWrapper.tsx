'use client';

/**
 * Apollo Client provider for Client Components.
 * Server Components use getClient() from lib/apollo directly.
 */
import { ApolloNextAppProvider } from '@apollo/experimental-nextjs-app-support';
import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Apollo type mismatch between RSC and client packages
function makeClient(): ApolloClient<any> {
  const httpLink = new HttpLink({
    uri: process.env['NEXT_PUBLIC_GATEWAY_URL'] ?? '/api/graphql',
    credentials: 'include',
    fetchOptions: { cache: 'no-store' },
  });

  return new ApolloClient({
    cache: new InMemoryCache(),
    link: httpLink,
  });
}

export function ApolloWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ApolloNextAppProvider makeClient={makeClient}>
      {children}
    </ApolloNextAppProvider>
  );
}
