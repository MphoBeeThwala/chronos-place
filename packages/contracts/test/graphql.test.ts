import { existsSync, readFileSync } from 'node:fs';
import {
  buildSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  validateSchema,
  type GraphQLNamedType,
  type GraphQLSchema,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import * as proto from '../gen/chronos/disclosure/v1/disclosure.js';
import type { ConditionStatus, GrantScope, HealthVisibility, Tier } from '../gen/graphql/types.js';
import { PUBLIC_MUTATIONS, schemaPath } from '../src/graphql/index.js';

const schema: GraphQLSchema = buildSchema(readFileSync(schemaPath, 'utf8'));

/** Types that may carry health data. Everything else must be free of health terms. */
const HEALTH_TYPES = new Set([
  'HealthCondition',
  'HealthConditionInput',
  'ConditionTaxonomyEntry',
  'HealthProfile',
  'HealthProfileInput',
  'HealthProfileView',
  'HealthViewer',
  'HealthVisibility',
  'GrantScope',
  'ConditionStatus',
]);

/** Query and Mutation fields that are health operations and resolve through the Disclosure Service. */
const HEALTH_OPERATIONS = new Set([
  'myHealthProfile',
  'healthProfileOf',
  'healthViewers',
  'conditionTaxonomy',
  'myHealthFilters',
  'upsertHealthProfile',
  'setHealthVisibility',
  'setHealthFilters',
  'shareHealthCard',
  'revokeHealthShare',
]);

const HEALTH_TERM =
  /health|condition|diagnos|medic|treatment|disclos|visibility|grant(?!ed)|\bhiv\b|taxonom|remission|survivor|filter/i;
const COORDINATE_TERM = /latitude|longitude|coordinate|geo|location/i;

const userTypes = (): GraphQLNamedType[] =>
  Object.values(schema.getTypeMap()).filter((t) => !t.name.startsWith('__'));

const fieldNames = (type: GraphQLNamedType): string[] =>
  isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)
    ? Object.keys(type.getFields())
    : [];

describe('client API schema', () => {
  it('is a valid GraphQL schema', () => {
    expect(validateSchema(schema)).toEqual([]);
  });

  it('defines every operation in TECHNICAL_SPEC section 6', () => {
    const queries = Object.keys(schema.getQueryType()?.getFields() ?? {});
    const mutations = Object.keys(schema.getMutationType()?.getFields() ?? {});
    expect(queries).toEqual(
      expect.arrayContaining([
        'me',
        'feed',
        'profile',
        'matches',
        'myHealthProfile',
        'healthProfileOf',
        'healthViewers',
      ]),
    );
    expect(mutations).toEqual(
      expect.arrayContaining([
        'requestOtp',
        'verifyOtp',
        'recordConsent',
        'updateProfile',
        'updatePreferences',
        'like',
        'pass',
        'unmatch',
        'block',
        'report',
        'upsertHealthProfile',
        'setHealthVisibility',
        'shareHealthCard',
        'revokeHealthShare',
        'requestDataExport',
        'deleteAccount',
      ]),
    );
  });
});

describe('privacy: health data stays on health types (CLAUDE.md rules 1 and 2)', () => {
  it('uses health vocabulary only on the dedicated health types and operations', () => {
    const offenders: string[] = [];
    for (const type of userTypes()) {
      const isRoot = type === schema.getQueryType() || type === schema.getMutationType();
      if (HEALTH_TERM.test(type.name) && !HEALTH_TYPES.has(type.name))
        offenders.push(`type ${type.name}`);
      if (HEALTH_TYPES.has(type.name)) continue;
      for (const field of fieldNames(type)) {
        if (isRoot && HEALTH_OPERATIONS.has(field)) continue;
        if (HEALTH_TERM.test(field)) offenders.push(`${type.name}.${field}`);
      }
      if (isObjectType(type) && isRoot) {
        for (const [name, field] of Object.entries(type.getFields())) {
          if (HEALTH_OPERATIONS.has(name)) continue;
          for (const arg of field.args)
            if (HEALTH_TERM.test(arg.name)) offenders.push(`${type.name}.${name}(${arg.name})`);
        }
      }
      if (isEnumType(type)) {
        for (const value of type.getValues()) {
          // The health-processing consent is a consent record, not health data.
          if (type.name === 'ConsentType' && value.name === 'HEALTH_PROCESSING') continue;
          if (HEALTH_TERM.test(value.name)) offenders.push(`${type.name}.${value.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps PublicProfile, Me and Match free of health fields', () => {
    for (const name of ['PublicProfile', 'Me', 'Match', 'Preferences', 'Report']) {
      const type = schema.getType(name);
      expect(type, name).toBeDefined();
      for (const field of fieldNames(type as GraphQLNamedType))
        expect(field).not.toMatch(HEALTH_TERM);
    }
  });

  it('returns health details to another member only as a nullable view', () => {
    const field = schema.getQueryType()?.getFields()['healthProfileOf'];
    expect(String(field?.type)).toBe('HealthProfileView');
    expect(String(schema.getQueryType()?.getFields()['myHealthProfile']?.type)).toBe(
      'HealthProfile',
    );
  });

  it('never returns coordinates (CLAUDE.md rule 8)', () => {
    const offenders: string[] = [];
    for (const type of userTypes()) {
      if (!isObjectType(type)) continue;
      for (const field of fieldNames(type))
        if (COORDINATE_TERM.test(field)) offenders.push(`${type.name}.${field}`);
    }
    expect(offenders).toEqual([]);
  });

  it('accepts coordinates only through the write-only LocationInput on ProfileInput', () => {
    const users = userTypes()
      .filter(isInputObjectType)
      .filter((t) =>
        Object.values(t.getFields()).some(
          (f) => String(f.type).replace(/[![\]]/g, '') === 'LocationInput',
        ),
      )
      .map((t) => t.name);
    expect(users).toEqual(['ProfileInput']);
    const queryArgs = Object.values(schema.getQueryType()?.getFields() ?? {}).flatMap((f) =>
      f.args.map((a) => a.name),
    );
    expect(queryArgs.filter((a) => COORDINATE_TERM.test(a))).toEqual([]);
  });
});

describe('consistency with the Disclosure proto', () => {
  const strip = (prefix: string, value: string): string => value.replace(prefix, '');
  const protoNames = (prefix: string, enumObject: Record<string, string | number>): string[] =>
    Object.keys(enumObject)
      .filter((k) => k.startsWith(prefix) && !k.endsWith('UNSPECIFIED') && k !== 'UNRECOGNIZED')
      .map((k) => strip(prefix, k))
      .sort();
  const graphqlNames = (name: string): string[] => {
    const type = schema.getType(name);
    return isEnumType(type)
      ? type
          .getValues()
          .map((v) => v.name)
          .sort()
      : [];
  };

  it.each([
    ['HealthVisibility', 'VISIBILITY_', proto.Visibility],
    ['GrantScope', 'GRANT_SCOPE_', proto.GrantScope],
    ['ConditionStatus', 'CONDITION_STATUS_', proto.ConditionStatus],
  ] as const)('%s has the same values as the proto enum', (name, prefix, protoEnum) => {
    expect(graphqlNames(name)).toEqual(protoNames(prefix, protoEnum));
  });
});

describe('generated types and public operations', () => {
  it('generates TypeScript types', () => {
    expect(existsSync(new URL('../gen/graphql/types.ts', import.meta.url))).toBe(true);
    const visibility: HealthVisibility = 'MATCH_ONLY';
    const scope: GrantScope = 'CONDITIONS_ONLY';
    const status: ConditionStatus = 'IN_REMISSION';
    const tier: Tier = 'PREMIUM';
    expect([visibility, scope, status, tier]).toHaveLength(4);
  });

  it('lists only real mutations as public, and only the sign-in ones', () => {
    const mutations = Object.keys(schema.getMutationType()?.getFields() ?? {});
    for (const name of PUBLIC_MUTATIONS) expect(mutations).toContain(name);
    expect([...PUBLIC_MUTATIONS]).toEqual(['requestOtp', 'verifyOtp', 'refreshSession']);
  });
});
