import type { ApolloServerPlugin } from '@apollo/server';
import { ONBOARDING_FIELDS, PUBLIC_MUTATIONS, VERIFIED_FIELDS } from '@chronos/contracts/graphql';
import {
  GraphQLError,
  OperationTypeNode,
  Kind,
  type SelectionSetNode,
  type DocumentNode,
  type OperationDefinitionNode,
} from 'graphql';
import type { GatewayContext } from './context.js';

export type AccountState = 'pending_onboarding' | 'active' | 'unavailable';

/** What the guard needs to know about the signed-in account. */
export interface AccountInfo {
  state: AccountState;
  /** A selfie liveness check has passed (ADR-0022). */
  verified: boolean;
}

const PUBLIC = new Set<string>(PUBLIC_MUTATIONS);
const ONBOARDING = new Set<string>(ONBOARDING_FIELDS);

/** Root fields an operation selects, following fragments. `__typename` is always allowed. */
export function rootFields(operation: OperationDefinitionNode, document: DocumentNode): string[] {
  const fragments = new Map(
    document.definitions.flatMap((d) =>
      d.kind === Kind.FRAGMENT_DEFINITION ? [[d.name.value, d]] : [],
    ),
  );
  const names: string[] = [];
  const seen = new Set<string>();
  const walk = (set: SelectionSetNode) => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) names.push(selection.name.value);
      else if (selection.kind === Kind.INLINE_FRAGMENT) walk(selection.selectionSet);
      else if (!seen.has(selection.name.value)) {
        seen.add(selection.name.value);
        const fragment = fragments.get(selection.name.value);
        if (fragment) walk(fragment.selectionSet);
      }
    }
  };
  walk(operation.selectionSet);
  return names.filter((n) => n !== '__typename');
}

function refuse(
  code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VERIFICATION_REQUIRED',
  message: string,
): never {
  throw new GraphQLError(message, {
    extensions: { code, http: { status: code === 'UNAUTHENTICATED' ? 401 : 403 } },
  });
}

/**
 * The sign-in guard (M1.3 AC: unauthenticated access blocked except the OTP mutations). It runs
 * after parsing and validation and before any resolver:
 * - no valid session: only requestOtp, verifyOtp and refreshSession;
 * - onboarding not finished: only the onboarding steps (ONBOARDING_FIELDS);
 * - an account that may no longer sign in: nothing but the public mutations;
 * - not yet verified: none of VERIFIED_FIELDS (M1.4 AC: messaging blocked until verified).
 */
export function authGuard(
  accountInfo: (accountId: string) => Promise<AccountInfo>,
  verifiedFields: readonly string[] = VERIFIED_FIELDS,
): ApolloServerPlugin<GatewayContext> {
  const needsVerification = new Set(verifiedFields);
  return {
    requestDidStart: () =>
      Promise.resolve({
        didResolveOperation: async ({ operation, document, contextValue }) => {
          if (!operation) refuse('FORBIDDEN', 'Operation not allowed.');
          const fields = rootFields(operation, document);
          // `{ __typename }` alone selects nothing and reveals nothing.
          if (fields.length === 0) return;
          const onlyPublic =
            operation.operation === OperationTypeNode.MUTATION &&
            fields.every((f) => PUBLIC.has(f));
          if (onlyPublic) return;
          const { viewer } = contextValue;
          if (!viewer) refuse('UNAUTHENTICATED', 'Sign in to continue.');
          const { state, verified } = await accountInfo(viewer.accountId);
          if (state === 'unavailable') refuse('UNAUTHENTICATED', 'Sign in to continue.');
          if (state === 'pending_onboarding' && !fields.every((f) => ONBOARDING.has(f))) {
            refuse('FORBIDDEN', 'Finish signing up first.');
          }
          if (!verified && fields.some((f) => needsVerification.has(f))) {
            refuse('VERIFICATION_REQUIRED', 'Verify your profile with a selfie first.');
          }
        },
      }),
  };
}
