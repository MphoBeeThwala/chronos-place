import { DomainError } from '@chronos/service-kit';
import { healthProfiles } from '@chronos/vault-db';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { NO_PROFILE } from '../health/health-profile.service.js';
import type { Grants } from '../vault/grants.js';
import type { SubjectDirectory } from '../vault/subjects.js';
import type { Scope } from './decide.js';
import type { MemberFacts } from './member-facts.js';
import type { Relationships } from './relationships.js';

// Fixed messages. One refusal covers no match, blocked and an inactive viewer, so the answer says
// nothing about the other member.
export const SHARE_NEEDS_MATCH = 'You can share only with a current match.';
export const CANNOT_SHARE_WITH_SELF = 'Invalid request.';
export const SHARE_CHANGED = 'Sharing changed elsewhere; reload and try again.';

export interface SharingDeps {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  grants: Grants;
  relationships: Relationships;
  members: MemberFacts;
}

/** GrantDisclosure and RevokeDisclosure: one-to-one sharing (M2.4). */
export class SharingService {
  readonly #deps: SharingDeps;

  constructor(deps: SharingDeps) {
    this.#deps = deps;
  }

  /**
   * Shares the subject's profile with one viewer. Needs a saved profile and an active match that
   * is not blocked, with an active viewer; until matching exists (M3.1) every share is refused.
   */
  async grant(
    subjectId: string,
    viewerId: string,
    scope: Scope,
  ): Promise<{ id: string; grantedAt: Date }> {
    const { db, subjects, grants } = this.#deps;
    if (subjectId === viewerId) throw new DomainError('invalid_argument', CANNOT_SHARE_WITH_SELF);
    const vaultId = await subjects.find(subjectId);
    const [profile] =
      vaultId === undefined
        ? []
        : await db
            .select({ vaultId: healthProfiles.vaultId })
            .from(healthProfiles)
            .where(eq(healthProfiles.vaultId, vaultId));
    if (vaultId === undefined || profile === undefined) {
      throw new DomainError('failed_precondition', NO_PROFILE);
    }
    if (!(await this.#mayShare(subjectId, viewerId))) {
      throw new DomainError('failed_precondition', SHARE_NEEDS_MATCH);
    }
    try {
      return await grants.replace(vaultId, viewerId, scope);
    } catch (error) {
      // Two shares to the same viewer at once: the unique index keeps one.
      if (
        (error as { cause?: { code?: string }; code?: string }).code === '23505' ||
        (error as { cause?: { code?: string } }).cause?.code === '23505'
      ) {
        throw new DomainError('aborted', SHARE_CHANGED);
      }
      throw error;
    }
  }

  /** Ends the share. Takes effect on the viewer's next request. False when nothing was shared. */
  async revoke(subjectId: string, viewerId: string): Promise<boolean> {
    const vaultId = await this.#deps.subjects.find(subjectId);
    return vaultId === undefined ? false : this.#deps.grants.revoke(vaultId, viewerId);
  }

  async #mayShare(subjectId: string, viewerId: string): Promise<boolean> {
    try {
      const relationship = await this.#deps.relationships.between(viewerId, subjectId);
      if (relationship === 'unavailable' || relationship.blocked || !relationship.activeMatch) {
        return false;
      }
      const active = await this.#deps.members.verifiedById([viewerId]);
      return active.has(viewerId);
    } catch {
      return false; // fail closed
    }
  }
}
