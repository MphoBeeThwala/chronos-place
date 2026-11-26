import { z } from 'zod';

/** Approved limits (M2.2): up to 10 conditions; own words and note up to 500 characters each. */
export const MAX_CONDITIONS = 10;
export const MAX_TEXT_LENGTH = 500;
/** The taxonomy entry that goes with the member's own words. */
export const OTHER_CODE = 'other';

export const CONDITION_STATUSES = ['living_with', 'in_remission', 'survivor'] as const;
export type ConditionStatus = (typeof CONDITION_STATUSES)[number];

/**
 * The plaintext sealed into `health_profiles.payload_ct` (TECHNICAL_SPEC 3.3). Exists only inside
 * the Disclosure Service, never logged, never returned to anyone but the member or a granted viewer.
 */
export const healthProfileSchema = z
  .object({
    conditions: z
      .array(
        z.object({
          code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
          status: z.enum(CONDITION_STATUSES),
        }),
      )
      .max(MAX_CONDITIONS),
    freeText: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
    note: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  })
  .strict();

export type HealthProfile = z.infer<typeof healthProfileSchema>;

export interface OwnHealthProfile {
  profile: HealthProfile;
  visibility: 'hidden' | 'match_only' | 'chat_grant' | 'profile';
  filterOptIn: boolean;
  version: number;
}
