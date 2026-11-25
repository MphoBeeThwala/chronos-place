import type { Page, Route } from '@playwright/test';

type Handler = (variables: Record<string, unknown>) => unknown;

const ERRORS = Symbol('graphql errors');
/** A handler result that answers with a GraphQL error instead of data. */
export const gqlError = (code: string, message = 'Synthetic error.') => ({
  [ERRORS]: [{ message, extensions: { code } }],
});

/**
 * Answers the app's GraphQL calls by operation name, so a flow can be tested in the browser
 * without the services running. Synthetic data only (CLAUDE.md rule 6).
 */
export async function mockGraphQL(page: Page, handlers: Record<string, Handler>) {
  const calls: { operationName: string; variables: Record<string, unknown> }[] = [];
  await page.route('**/api/graphql', async (route: Route) => {
    const body = route.request().postDataJSON() as {
      operationName: string;
      variables?: Record<string, unknown>;
    };
    const variables = body.variables ?? {};
    calls.push({ operationName: body.operationName, variables });
    const handler = handlers[body.operationName];
    if (!handler) {
      await route.fulfill({
        json: { errors: [{ message: 'Not mocked', extensions: { code: 'NOT_AVAILABLE' } }] },
      });
      return;
    }
    const result = handler(variables) as Record<symbol, unknown> | undefined;
    if (result && ERRORS in result) {
      await route.fulfill({ json: { data: null, errors: result[ERRORS] } });
      return;
    }
    await route.fulfill({ json: { data: result } });
  });
  return calls;
}

/** The session cookie the middleware looks for; the mocked gateway does the rest. */
export async function signedIn(page: Page) {
  await page
    .context()
    .addCookies([{ name: 'chronos_session', value: 'synthetic', url: 'http://localhost:3000' }]);
}
