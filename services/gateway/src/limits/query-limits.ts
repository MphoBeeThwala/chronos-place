import type { ApolloServerPlugin } from '@apollo/server';
import {
  GraphQLError,
  type ASTVisitor,
  type FragmentDefinitionNode,
  Kind,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';
import { getComplexity, simpleEstimator, type ComplexityEstimator } from 'graphql-query-complexity';

/** Approved query limits (ADR-0021). */
export const QUERY_LIMITS = {
  maxDepth: 10,
  maxComplexity: 1000,
  /** Characters of query text; the web app's operations are far smaller. */
  maxQueryLength: 20_000,
  /** Bytes of JSON variables. */
  maxVariablesBytes: 16_384,
} as const;

const tooLarge = (): GraphQLError =>
  new GraphQLError('Request too large.', {
    extensions: { code: 'BAD_USER_INPUT', http: { status: 413 } },
  });

/** Checked while the request context is built, before parsing. */
export function assertRequestSize(
  body: { query?: unknown; variables?: unknown } | undefined,
): void {
  if (typeof body?.query === 'string' && body.query.length > QUERY_LIMITS.maxQueryLength)
    throw tooLarge();
  if (
    body?.variables !== undefined &&
    JSON.stringify(body.variables).length > QUERY_LIMITS.maxVariablesBytes
  ) {
    throw tooLarge();
  }
}

/** Validation rule: no selection deeper than maxDepth, counting through fragments. */
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const d of context.getDocument().definitions) {
      if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
    }
    const depthOf = (set: SelectionSetNode, depth: number, visiting: Set<string>): number => {
      let max = depth;
      for (const s of set.selections) {
        if (s.kind === Kind.FIELD) {
          if (s.selectionSet) max = Math.max(max, depthOf(s.selectionSet, depth + 1, visiting));
        } else if (s.kind === Kind.INLINE_FRAGMENT) {
          max = Math.max(max, depthOf(s.selectionSet, depth, visiting));
        } else if (!visiting.has(s.name.value)) {
          const fragment = fragments.get(s.name.value);
          if (fragment) {
            visiting.add(s.name.value);
            max = Math.max(max, depthOf(fragment.selectionSet, depth, visiting));
            visiting.delete(s.name.value);
          }
        }
      }
      return max;
    };
    return {
      OperationDefinition(node) {
        if (depthOf(node.selectionSet, 1, new Set()) > maxDepth) {
          context.reportError(
            new GraphQLError('Query too deep.', {
              nodes: [node],
              extensions: { code: 'BAD_USER_INPUT' },
            }),
          );
        }
      },
    };
  };
}

/**
 * Paginated fields (those with a `first` argument) multiply their children's cost by the page size
 * asked for, or the schema's default. Other lists are small and bounded by the data model.
 */
const paginationEstimator: ComplexityEstimator = ({ args, childComplexity, field }) => {
  const firstArg = field.args.find((a) => a.name === 'first');
  if (!firstArg) return undefined;
  const first =
    typeof args['first'] === 'number' ? args['first'] : Number(firstArg.defaultValue ?? 20);
  return 1 + childComplexity * Math.max(1, first);
};

/** Refuses operations whose estimated cost exceeds maxComplexity, before they run. */
export function complexityLimit(): ApolloServerPlugin {
  return {
    requestDidStart: () =>
      Promise.resolve({
        didResolveOperation: ({ request, document, schema }) => {
          const complexity = getComplexity({
            schema,
            query: document,
            ...(request.operationName ? { operationName: request.operationName } : {}),
            variables: request.variables ?? {},
            estimators: [paginationEstimator, simpleEstimator({ defaultComplexity: 1 })],
          });
          if (complexity > QUERY_LIMITS.maxComplexity) {
            throw new GraphQLError('Query too complex.', {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }
          return Promise.resolve();
        },
      }),
  };
}
