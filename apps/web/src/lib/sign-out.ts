import { OPERATIONS } from '@/graphql/operations.generated';
import { GRAPHQL_PATH } from './session-refresh';

/**
 * Ends this device's session without Apollo. `keepalive` lets the request finish after the page
 * has gone, so quick exit never waits for it (ADR-0017). Failures are ignored: a member who is
 * already signed out has nothing to end.
 */
export function sendSignOut(options: { keepalive?: boolean } = {}): Promise<void> {
  const { hash, text } = OPERATIONS.SignOut;
  return fetch(GRAPHQL_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: options.keepalive ?? false,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationName: 'SignOut',
      query: text,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }),
  }).then(
    () => undefined,
    () => undefined,
  );
}
