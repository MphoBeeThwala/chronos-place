import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApolloServerPlugin } from '@apollo/server';
import { GraphQLError } from 'graphql';

/**
 * Approved operations (ADR-0021, decision b). The manifest maps the SHA-256 of each operation's
 * text to the text, built from the web app's code. In production the gateway runs only operations
 * from the manifest, chosen by hash; free-form queries are refused. Development and test also
 * accept free-form queries, so tools and tests keep working.
 */
export class PersistedOperations {
  readonly #byHash: ReadonlyMap<string, string>;

  constructor(entries: Record<string, string>) {
    for (const [hash, text] of Object.entries(entries)) {
      if (hashOperation(text) !== hash)
        throw new Error('persisted operation hash does not match its text');
    }
    this.#byHash = new Map(Object.entries(entries));
  }

  static fromFile(path: string): PersistedOperations {
    return new PersistedOperations(
      JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>,
    );
  }

  get(hash: string): string | undefined {
    return this.#byHash.get(hash);
  }

  get size(): number {
    return this.#byHash.size;
  }
}

export const hashOperation = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

interface RequestBody {
  query?: unknown;
  extensions?: { persistedQuery?: { sha256Hash?: unknown } };
}

const hashOf = (body: RequestBody | undefined): string | undefined => {
  const hash = body?.extensions?.persistedQuery?.sha256Hash;
  return typeof hash === 'string' ? hash : undefined;
};

/**
 * Checked while the request context is built, before anything is parsed: in production, a request
 * must name an approved operation by hash.
 */
export function assertApproved(
  body: RequestBody | undefined,
  operations: PersistedOperations | undefined,
  enforce: boolean,
): void {
  if (!enforce) return;
  const hash = hashOf(body);
  if (hash === undefined || operations?.get(hash) === undefined) {
    throw new GraphQLError('Only approved operations are accepted.', {
      extensions: { code: 'PERSISTED_QUERY_NOT_FOUND', http: { status: 400 } },
    });
  }
}

/**
 * Runs the manifest's text for a known hash, whatever text the client sent, and drops the hash so
 * Apollo's own automatic persisted queries (disabled) never see it.
 */
export function persistedOperationsPlugin(
  operations: PersistedOperations | undefined,
): ApolloServerPlugin {
  return {
    requestDidStart: ({ request }) => {
      const extensions = request.extensions as RequestBody['extensions'] | undefined;
      const hash = hashOf(extensions ? { extensions } : undefined);
      if (hash !== undefined) {
        const text = operations?.get(hash);
        if (text !== undefined) request.query = text;
        if (extensions) delete extensions.persistedQuery;
      }
      return Promise.resolve();
    },
  };
}
