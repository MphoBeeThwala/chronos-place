import { buildSchema, GraphQLError } from 'graphql';

export type ResolverMap = Record<string, Record<string, (...args: unknown[]) => unknown>>;

const notAvailable = () => {
  throw new GraphQLError('Not available yet.', { extensions: { code: 'NOT_AVAILABLE' } });
};

/**
 * A resolver for every Query and Mutation field that answers "not available yet". Fields get
 * real resolvers as their services arrive; overrides replace these.
 */
export function rootResolvers(sdl: string, overrides: ResolverMap = {}): ResolverMap {
  const schema = buildSchema(sdl);
  const map: ResolverMap = {};
  for (const type of [schema.getQueryType(), schema.getMutationType()]) {
    if (!type) continue;
    map[type.name] = Object.fromEntries(
      Object.keys(type.getFields()).map((field) => [
        field,
        overrides[type.name]?.[field] ?? notAvailable,
      ]),
    );
  }
  return map;
}
