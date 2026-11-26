import type { AllowList } from '@chronos/service-kit';

/**
 * Who may call each discovery method (M2.5), identified by mTLS certificate. Anything not listed is
 * refused. Kept in step with the contract's `Caller` comments by test/allow-list.test.ts.
 */
export const DISCOVERY_ALLOW_LIST: AllowList = {
  service: 'chronos.discovery.v1.DiscoveryService',
  methods: {
    GetFeed: ['gateway'],
  },
};
