import { QueryClient } from '@tanstack/react-query';

/**
 * The app's query client. The cache lives in memory only and is never persisted: health views must
 * not reach the disk (ADR-0009), and the TanStack persistence packages are banned by `pnpm check:deps`.
 * Short cache lifetimes mean a screen that is gone does not leave data lying around.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}
