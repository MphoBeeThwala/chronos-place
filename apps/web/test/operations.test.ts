import { readFileSync } from 'node:fs';
import { PUBLIC_MUTATIONS, schemaPath } from '@chronos/contracts/graphql';
import {
  buildSchema,
  Kind,
  OperationTypeNode,
  parse,
  validate,
  type OperationDefinitionNode,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '@/graphql/operations.generated';
import manifest from '@/graphql/persisted-operations.json';

const schema = buildSchema(readFileSync(schemaPath, 'utf8'));

describe('approved operations (ADR-0021)', () => {
  it.each(Object.entries(OPERATIONS))(
    '%s is valid against the client schema',
    (_name, { text }) => {
      expect(validate(schema, parse(text))).toEqual([]);
    },
  );

  it('lists every operation in the manifest the gateway loads, under its hash', () => {
    for (const { hash, text } of Object.values(OPERATIONS)) {
      expect((manifest as Record<string, string>)[hash]).toBe(text);
    }
    expect(Object.keys(manifest)).toHaveLength(Object.keys(OPERATIONS).length);
  });

  it('uses only the sign-in mutations without a session', () => {
    const sessionless = new Set(['RequestOtp', 'VerifyOtp', 'RefreshSession']);
    for (const [name, { text }] of Object.entries(OPERATIONS)) {
      const op = parse(text).definitions[0] as OperationDefinitionNode;
      const fields = op.selectionSet.selections.flatMap((s) =>
        s.kind === Kind.FIELD ? [s.name.value] : [],
      );
      const isPublic =
        op.operation === OperationTypeNode.MUTATION &&
        fields.every((f) => (PUBLIC_MUTATIONS as readonly string[]).includes(f));
      expect(isPublic, name).toBe(sessionless.has(name));
    }
  });
});
