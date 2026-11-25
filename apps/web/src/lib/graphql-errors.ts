/** The gateway's messages are written for members; anything else gets a plain fallback. */
export function messageOf(error: unknown): string {
  const graphQLErrors = (
    error as { graphQLErrors?: { message: string; extensions?: { code?: string } }[] }
  ).graphQLErrors;
  const first = graphQLErrors?.[0];
  if (first && first.extensions?.code !== 'INTERNAL_SERVER_ERROR') return first.message;
  return 'Something went wrong. Try again.';
}
