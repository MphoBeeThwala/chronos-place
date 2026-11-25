import type { PhotoModeration } from '../db/schema.js';

/**
 * The moderation status hook (TASKS M1.6, ADR-0024 decision e). Moderation (M5) plugs in here;
 * it receives only the photo id and owner, and reads the processed image itself if it needs it.
 */
export interface PhotoModerator {
  /** The status a new photo starts with. "pending" leaves it for a later decision. */
  review(photo: { id: string; accountId: string }): Promise<PhotoModeration>;
}

/** Development only: every photo is approved at once, so the app can be tried end to end. */
export class AutoApproveModerator implements PhotoModerator {
  review(): Promise<PhotoModeration> {
    return Promise.resolve('approved');
  }
}

/** Everywhere else until M5: photos wait as "pending", so none are shown to other members. */
export class HoldForReviewModerator implements PhotoModerator {
  review(): Promise<PhotoModeration> {
    return Promise.resolve('pending');
  }
}
