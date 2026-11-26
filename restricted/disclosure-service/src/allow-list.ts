import { Purpose } from '@chronos/contracts/disclosure';
import type { AllowList } from '@chronos/service-kit';

const isModeration = (request: unknown): boolean =>
  (request as { purpose?: unknown }).purpose === Purpose.PURPOSE_MODERATION;

/**
 * Who may call each Disclosure Service method (TECHNICAL_SPEC 4.1, M2.5). Identified by mTLS
 * certificate; anything not listed is refused. Kept in step with the contract's `Caller` comments by
 * test/allow-list.test.ts.
 */
export const DISCLOSURE_ALLOW_LIST: AllowList = {
  service: 'chronos.disclosure.v1.DisclosureService',
  methods: {
    UpsertHealthProfile: ['gateway'],
    GetOwnHealthProfile: ['gateway'],
    SetVisibility: ['gateway'],
    GrantDisclosure: ['gateway'],
    RevokeDisclosure: ['gateway'],
    ViewHealthProfile: [
      // Members' views only: the gateway may never claim the moderation purpose.
      { caller: 'gateway', when: (request) => !isModeration(request) },
      // Moderation views only, and only with a report id (ADR-0015: moderation enforces the open
      // report and the time limit; both ids are audited).
      {
        caller: 'moderation',
        when: (request) => {
          const report = (request as { moderation?: { reportId?: unknown } }).moderation?.reportId;
          return isModeration(request) && typeof report === 'string' && report.length > 0;
        },
      },
    ],
    ListHealthViewers: ['gateway'],
    ListConditionTaxonomy: ['gateway'],
    SetFilterPreferences: ['gateway'],
    GetFilterPreferences: ['gateway'],
    FilterEligibleSubjects: ['discovery'],
    // No caller until ADR-0025 decision g is made.
    ExportSubject: [],
    EraseSubject: ['identity'],
  },
};
