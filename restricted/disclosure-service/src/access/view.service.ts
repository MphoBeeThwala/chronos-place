import { DomainError } from '@chronos/service-kit';
import { healthProfiles } from '@chronos/vault-db';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { HealthProfile } from '../health/health-profile.js';
import type { HealthProfileService } from '../health/health-profile.service.js';
import type { AccessLog } from '../vault/access-log.js';
import type { Grants } from '../vault/grants.js';
import type { SubjectDirectory } from '../vault/subjects.js';
import { decide, type AccessFacts, type Scope, type ViewPurpose } from './decide.js';
import type { MemberFacts } from './member-facts.js';
import type { Relationships } from './relationships.js';

/** How long a viewer's app may keep a view before asking again (M2.3 decision). */
export const LEASE_MS = 5 * 60_000;
export const MODERATION_CONTEXT_REQUIRED = 'Invalid request.';

export interface ViewRequest {
  viewerId: string;
  subjectId: string;
  purpose: ViewPurpose;
  /** Required for moderation: the staff member asking. */
  staffId?: string | undefined;
}

export interface HealthView {
  scope: Scope;
  conditions: HealthProfile['conditions'];
  /** Only with full scope. */
  freeText?: string | undefined;
  note?: string | undefined;
  leaseExpiresAt: Date;
}

export interface ViewDeps {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  grants: Grants;
  relationships: Relationships;
  members: MemberFacts;
  profiles: HealthProfileService;
  accessLog: AccessLog;
  now?: () => number;
}

/**
 * ViewHealthProfile: gathers the facts, decides (decide.ts), records the decision, and only then
 * opens the profile. The caller learns allowed or not, never why, and "no profile" looks the same
 * as "hidden".
 */
export class ViewService {
  readonly #deps: ViewDeps;

  constructor(deps: ViewDeps) {
    this.#deps = deps;
  }

  async view(request: ViewRequest): Promise<HealthView | undefined> {
    const { db, subjects, grants, profiles, accessLog } = this.#deps;
    if (request.purpose === 'moderation' && request.staffId === undefined) {
      throw new DomainError('invalid_argument', MODERATION_CONTEXT_REQUIRED);
    }
    const vaultId = await subjects.find(request.subjectId);
    // Nothing about the subject is in the vault: nothing to read and nothing to record.
    if (vaultId === undefined) return undefined;

    const [row] = await db
      .select({ visibility: healthProfiles.visibility })
      .from(healthProfiles)
      .where(eq(healthProfiles.vaultId, vaultId));
    const self = request.viewerId === request.subjectId;
    const facts: AccessFacts = {
      viewerId: request.viewerId,
      subjectId: request.subjectId,
      purpose: request.purpose,
      visibility: row?.visibility,
      // Self views need no outside facts (decide allows them first).
      relationship: self ? 'unavailable' : await this.#relationship(request),
      members: self ? 'unavailable' : await this.#members(request),
      grant: self ? undefined : await grants.liveScope(vaultId, request.viewerId),
    };
    const decision = decide(facts);

    await accessLog.record({
      vaultId,
      accessor:
        request.purpose === 'moderation'
          ? `staff:${request.staffId ?? ''}`
          : `account:${request.viewerId}`,
      purpose: request.purpose,
      decision: decision.allow ? 'allow' : 'deny',
      reason: decision.reason,
    });
    if (!decision.allow) return undefined;

    const opened = await profiles.open(vaultId);
    if (opened === undefined) return undefined;
    const leaseExpiresAt = new Date((this.#deps.now ?? Date.now)() + LEASE_MS);
    return decision.scope === 'full'
      ? {
          scope: 'full',
          conditions: opened.profile.conditions,
          freeText: opened.profile.freeText,
          note: opened.profile.note,
          leaseExpiresAt,
        }
      : { scope: 'conditions_only', conditions: opened.profile.conditions, leaseExpiresAt };
  }

  async #relationship(request: ViewRequest): Promise<AccessFacts['relationship']> {
    try {
      return await this.#deps.relationships.between(request.viewerId, request.subjectId);
    } catch {
      return 'unavailable';
    }
  }

  async #members(request: ViewRequest): Promise<AccessFacts['members']> {
    try {
      const verified = await this.#deps.members.verifiedById([request.viewerId, request.subjectId]);
      return {
        subjectActive: verified.has(request.subjectId),
        viewerVerified: verified.get(request.viewerId) === true,
      };
    } catch {
      return 'unavailable';
    }
  }
}
