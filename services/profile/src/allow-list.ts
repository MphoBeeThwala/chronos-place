import type { AllowList } from '@chronos/service-kit';

/**
 * Who may call each profile method (M2.5), identified by mTLS certificate. Anything not listed is
 * refused. Kept in step with the contract's `Caller` comments by test/allow-list.test.ts.
 */
export const PROFILE_ALLOW_LIST: AllowList = {
  service: 'chronos.profile.v1.ProfileService',
  methods: {
    GetOwnProfile: ['gateway'],
    UpdateProfile: ['gateway'],
    UpdatePreferences: ['gateway'],
    GetCatalogue: ['gateway'],
    SetLocation: ['gateway'],
    GetPublicProfiles: ['gateway', 'discovery'],
    FindCandidates: ['discovery'],
    CreatePhotoUpload: ['gateway'],
    CompletePhotoUpload: ['gateway'],
    ListOwnPhotos: ['gateway'],
    ReorderPhotos: ['gateway'],
    DeletePhoto: ['gateway'],
    ExportProfile: ['gateway'],
  },
};
